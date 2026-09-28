import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, extract, isoIn, startServer } from '../helpers.ts';

/**
 * One whole event through the real forms, as the demo video shows it:
 * create, form teams, submit, invite and assign judges, score, publish.
 * Steps share state and run in order.
 */
describe('a full event lifecycle through the web forms', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let carol: Client;
  let jude: Client;
  let kim: Client;
  const slug = 'spring-build-2026';
  let toolsTrack = '';
  let gamesTrack = '';
  let alphaProject = '';
  let betaProject = '';
  let judeInvite = '';
  let kimInvite = '';

  before(async () => {
    server = await startServer();
    admin = new Client(server.url);
    alice = new Client(server.url);
    bob = new Client(server.url);
    carol = new Client(server.url);
    jude = new Client(server.url);
    kim = new Client(server.url);
  });
  after(() => server.close());

  test('an administrator creates an event with tracks and a deadline', async () => {
    assert.equal((await admin.signIn('admin@forgeboard.local')).status, 303);
    const reply = await admin.postForm('/events/new', {
      name: 'Spring Build 2026',
      tagline: 'Two tracks, one weekend.',
      submissions_close_at: isoIn(60),
      max_team_size: '3',
      reviews_per_project: '2',
      tracks: 'Tools\nGames',
    });
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.get('location'), `/organize/${slug}`);
    const event = await admin.getJson(`/api/events/${slug}`);
    const tracks = event.json<{ tracks: { id: string; name: string }[]; rubric: unknown[] }>();
    toolsTrack = tracks.tracks.find((t) => t.name === 'Tools')?.id ?? '';
    gamesTrack = tracks.tracks.find((t) => t.name === 'Games')?.id ?? '';
    assert.ok(toolsTrack && gamesTrack);
    assert.equal(tracks.rubric.length, 3, 'starts with the default rubric');
  });

  test('the organizer adds a prize and reweights the rubric', async () => {
    assert.equal((await admin.postForm(`/organize/${slug}/prizes`, { name: 'Best tool', track_id: toolsTrack, description: '' })).status, 303);
    const rubric = await admin.get(`/organize/${slug}/rubric`);
    const ids = [...rubric.text.matchAll(/name="weight_(crt_[a-z0-9]+)"/g)].map((m) => m[1] as string);
    const names = [...rubric.text.matchAll(/name="name_crt_[a-z0-9]+" value="([^"]+)"/g)].map((m) => m[1] as string);
    const form: Record<string, string> = { score_min: '1', score_max: '5' };
    ids.forEach((id, i) => {
      form[`name_${id}`] = names[i] ?? '';
      form[`description_${id}`] = '';
      form[`weight_${id}`] = i === 0 ? '2' : '1';
    });
    assert.equal((await admin.postForm(`/organize/${slug}/rubric`, form)).status, 303);
    const weights = (await admin.getJson(`/api/events/${slug}`)).json<{ rubric: { weight: number }[] }>().rubric.map((c) => c.weight);
    assert.deepEqual(weights, [2, 1, 1]);
  });

  test('participants sign up, form a team and join it by invite link', async () => {
    assert.equal((await alice.postForm('/signup', { name: 'Alice', email: 'alice@example.com', password: 'alice-password' }, { tokenFrom: '/signup' })).status, 303);
    const team = await alice.postForm(`/events/${slug}/team`, { name: 'Alpha' });
    assert.equal(team.status, 201);
    const invite = extract(team.text, /value="https?:\/\/[^"]*(\/join\/[\w-]+)"/);

    assert.equal((await bob.postForm('/signup', { name: 'Bob', email: 'bob@example.com', password: 'bob-password' }, { tokenFrom: '/signup' })).status, 303);
    assert.match((await bob.get(invite)).text, /Join Alpha/);
    assert.equal((await bob.postForm(invite, {})).status, 303);
    assert.match((await bob.get(`/events/${slug}/team`)).text, /Bob[\s\S]*Alice|Alice[\s\S]*Bob/);

    assert.equal((await carol.postForm('/signup', { name: 'Carol', email: 'carol@example.com', password: 'carol-password' }, { tokenFrom: '/signup' })).status, 303);
    assert.equal((await carol.postForm(`/events/${slug}/team`, { name: 'Beta' })).status, 201);
    assert.equal((await carol.postForm(invite, {})).status, 409, 'Carol is already on a team');
  });

  test('a draft is private; a submission is public', async () => {
    const draft = await alice.postForm(`/projects/new?event=${slug}`, { title: 'Alpha Tool', summary: '', track_id: toolsTrack, intent: 'draft' });
    assert.equal(draft.status, 303);
    alphaProject = extract(draft.headers.get('location') ?? '', /\/projects\/(prj_\w+)/);
    assert.equal((await new Client(server.url).get(`/projects/${alphaProject}`)).status, 404);
    assert.doesNotMatch((await new Client(server.url).get(`/projects?event=${slug}`)).text, /Alpha Tool/);

    const incomplete = await bob.postForm(`/projects/${alphaProject}/edit`, { version: '1', title: 'Alpha Tool', summary: '', track_id: toolsTrack, intent: 'submit' });
    assert.equal(incomplete.status, 422, 'a submission needs a summary and a link');
    assert.match(incomplete.text, /summary is required to submit/);

    const submitted = await bob.postForm(`/projects/${alphaProject}/edit`, {
      version: '1', title: 'Alpha Tool', summary: 'Lints your commit messages.', track_id: toolsTrack, repo_url: 'https://example.org/alpha', intent: 'submit',
    });
    assert.equal(submitted.status, 303);
    assert.equal((await new Client(server.url).get(`/projects/${alphaProject}`)).status, 200);
    assert.match((await new Client(server.url).get(`/projects?event=${slug}`)).text, /Alpha Tool/);

    const beta = await carol.postJson(`/projects/new?event=${slug}`, { title: 'Beta Game', summary: 'A tiny roguelike.', track_id: gamesTrack, demo_url: 'https://example.org/beta', intent: 'submit' });
    assert.equal(beta.status, 201);
    betaProject = beta.json<{ project: { id: string } }>().project.id;
  });

  test('a stale edit is refused instead of overwriting a teammate', async () => {
    const stale = await alice.postForm(`/projects/${alphaProject}/edit`, { version: '1', title: 'Overwrite', summary: 'x', track_id: toolsTrack, repo_url: 'https://example.org/x' });
    assert.equal(stale.status, 409);
    assert.equal((await alice.getJson(`/api/projects/${alphaProject}`)).json<{ project: { title: string } }>().project.title, 'Alpha Tool');
  });

  test('the organizer invites two judges and they claim their accounts', async () => {
    const first = await admin.postForm(`/organize/${slug}/judges`, { name: 'Jude', email: 'jude@example.com', track_ids: [toolsTrack] });
    assert.equal(first.status, 201);
    judeInvite = extract(first.text, /value="https?:\/\/[^"]*(\/judge-invite\/[\w-]+)"/);
    const second = await admin.postForm(`/organize/${slug}/judges`, { name: 'Kim', email: 'kim@example.com' });
    kimInvite = extract(second.text, /value="https?:\/\/[^"]*(\/judge-invite\/[\w-]+)"/);

    const conflicted = await admin.postForm(`/organize/${slug}/judges`, { name: 'Alice', email: 'alice@example.com' });
    assert.equal(conflicted.status, 422, 'a competitor cannot judge');

    assert.match((await jude.get(judeInvite)).text, /Choose a password to accept/);
    assert.equal((await jude.postForm(judeInvite, { password: 'jude-password' }, { tokenFrom: judeInvite })).status, 303);
    assert.equal((await kim.postForm(kimInvite, { password: 'kim-password' }, { tokenFrom: kimInvite })).status, 303);
    assert.equal((await jude.get(judeInvite)).status, 410, 'an invite works once');
    assert.equal((await new Client(server.url).postForm('/signup', { name: 'Imposter', email: 'jude@example.com', password: 'whatever1' }, { tokenFrom: '/signup' })).status, 422);
  });

  test('the organizer closes submissions; after that every write is refused', async () => {
    assert.equal((await admin.postForm(`/organize/${slug}/close-submissions`, {})).status, 303);
    const late = await alice.postForm(`/projects/${alphaProject}/edit`, { title: 'Late change', summary: 'x', track_id: toolsTrack, repo_url: 'https://example.org/x' });
    assert.equal(late.status, 403);
    assert.match(late.text, /closed on/);
    assert.equal((await carol.postJson(`/projects/${betaProject}/withdraw`, {})).status, 403);
    const dave = new Client(server.url);
    await dave.postForm('/signup', { name: 'Dave', email: 'dave@example.com', password: 'dave-password' }, { tokenFrom: '/signup' });
    assert.equal((await dave.postForm(`/events/${slug}/team`, { name: 'Gamma' })).status, 403);
  });
});
