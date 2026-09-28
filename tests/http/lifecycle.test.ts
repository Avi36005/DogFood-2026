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
});
