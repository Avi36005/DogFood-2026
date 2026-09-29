import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ballotSeed, shuffle } from '../../src/domain/voting.ts';
import { Client, isoIn, startServer } from '../helpers.ts';

const E = 'sample-hack-2026';
const O = `/organize/${E}`;

async function signUp(base: string, name: string): Promise<Client> {
  const client = new Client(base);
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@voters.example`;
  const reply = await client.postForm('/signup', { name, email, password: 'voter-password-1' }, { tokenFrom: '/signup' });
  assert.equal(reply.status, 303, `sign-up of ${name}`);
  return client;
}

const pickIds = (text: string) => [...text.matchAll(/name="pick" value="(prj_\d+)"(?![^>]*disabled)/g)].map((m) => m[1] as string);

describe('community vote: signed-in accounts', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let org: Client;
  const store = () => server.booted.store;

  before(async () => {
    server = await startServer();
    org = Client.as(server.url, 'organizer');
    const reply = await org.postForm(`${O}/voting`, { opens_at: isoIn(-60), closes_at: isoIn(120), access: 'accounts', max_picks: '2' });
    assert.equal(reply.status, 303);
  });
  after(() => server.close());

  test('the tally is hidden from everyone but organizers while voting runs', async () => {
    assert.match((await new Client(server.url).get(`/events/${E}/vote/results`)).text, /Hidden for now/);
    assert.equal((await new Client(server.url).getJson(`/api/events/${E}/vote`)).json<{ tally: unknown }>().tally, null);
    assert.equal((await Client.as(server.url, 'participant').getJson(`/api/events/${E}/vote`)).json<{ tally: unknown }>().tally, null);
    assert.match((await org.get(`/events/${E}/vote/results`)).text, /Only organizers can see this/);
    assert.notEqual((await org.getJson(`/api/events/${E}/vote`)).json<{ tally: unknown }>().tally, null);
  });

  test('a participant votes once; their own project is on the ballot but cannot be approved', async () => {
    const voter = Client.as(server.url, 'participant');
    const page = await voter.get(`/events/${E}/vote`);
    assert.match(page.text, /your team/);
    const own = /name="pick" value="(prj_\d+)"[^>]*disabled/.exec(page.text)?.[1];
    assert.ok(own, 'the voter’s own project is shown, disabled');
    const choices = pickIds(page.text);
    assert.equal(choices.length, 39, '40 live projects, minus the voter’s own');

    assert.equal((await voter.postForm(`/events/${E}/vote`, { pick: [own] }, { tokenFrom: `/events/${E}/vote` })).status, 422, 'own project refused by the backend');
    assert.equal((await voter.postForm(`/events/${E}/vote`, { pick: choices.slice(0, 3) }, { tokenFrom: `/events/${E}/vote` })).status, 422, 'more than max_picks refused');
    assert.equal((await voter.postForm(`/events/${E}/vote`, {}, { tokenFrom: `/events/${E}/vote` })).status, 422, 'an empty ballot refused');
    const cast = await voter.postForm(`/events/${E}/vote`, { pick: choices.slice(0, 2) }, { tokenFrom: `/events/${E}/vote` });
    assert.equal(cast.status, 200);
    assert.match(cast.text, /Thank you for voting/);
    assert.match((await voter.get(`/events/${E}/vote`)).text, /Your ballot was recorded/);
    const again = await voter.request('POST', `/events/${E}/vote`, { body: JSON.stringify({ pick: choices.slice(2, 3) }), type: 'application/json' });
    assert.equal(again.status, 409, 'one ballot per account');
    assert.throws(() => store().run('UPDATE ballot_picks SET project_id = project_id'), /ballot picks are final/);
  });

  test('judges and organizers are refused a ballot, and the refusal is audited', async () => {
    const judge = Client.as(server.url, 'judge_a');
    assert.match((await judge.get(`/events/${E}/vote`)).text, /do not take part/);
    const reply = await judge.request('POST', `/events/${E}/vote`, { body: JSON.stringify({ pick: ['prj_02'] }), type: 'application/json' });
    assert.equal(reply.status, 403);
    const audit = (await org.get(`${O}/audit?action=access.denied`)).text;
    assert.match(audit, /refused a community-vote ballot \(they are a judge of the event\)/);
  });

  test('every voter sees their own order: stable on reload, different between voters', async () => {
    const a = await signUp(server.url, 'Ada Voter');
    const b = await signUp(server.url, 'Ben Voter');
    const orderA = pickIds((await a.get(`/events/${E}/vote`)).text);
    const orderB = pickIds((await b.get(`/events/${E}/vote`)).text);
    assert.deepEqual(pickIds((await a.get(`/events/${E}/vote`)).text), orderA, 'the same order on reload');
    assert.notDeepEqual(orderA, orderB, 'another voter, another order');
    assert.deepEqual([...orderA].sort(), [...orderB].sort(), 'the same projects');
    // Across many seeds, each project leads about equally often: no position bias built in.
    const firsts = new Map<string, number>();
    const items = Array.from({ length: 8 }, (_, i) => `p${i}`);
    for (let voter = 0; voter < 4000; voter++) {
      const first = shuffle(items, ballotSeed('secret', 'evt', `v${voter}`))[0] as string;
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    for (const count of firsts.values()) assert.ok(count > 400 && count < 600, `first place ${count} of 4000 (expect about 500)`);
    // Both ballots cast from the test's one address make a reviewable cluster with the first one.
    assert.equal((await a.postForm(`/events/${E}/vote`, { pick: [orderA[0] as string] }, { tokenFrom: `/events/${E}/vote` })).status, 200);
    assert.equal((await b.postForm(`/events/${E}/vote`, { pick: [orderB[0] as string] }, { tokenFrom: `/events/${E}/vote` })).status, 200);
  });

  test('ballots from one address are flagged for review; voiding needs a reason and is audited', async () => {
    const page = (await org.get(`${O}/voting`)).text;
    assert.match(page, /Ballots to review/);
    const ballot = /<code>(bal_[a-z0-9]+)<\/code>/.exec(page)?.[1] as string;
    assert.equal((await org.postForm(`${O}/voting/ballots/${ballot}/void`, { reason: '' }, { tokenFrom: `${O}/voting` })).status, 422);
    assert.equal((await org.postForm(`${O}/voting/ballots/${ballot}/void`, { reason: 'Same person, second account (confirmed at the desk).' }, { tokenFrom: `${O}/voting` })).status, 303);
    assert.equal(store().get<{ n: number }>('SELECT count(*) AS n FROM ballots WHERE voided_at IS NULL')?.n, 2);
    assert.match((await org.get(`${O}/audit?action=vote`)).text, /Voided ballot bal_.*Same person, second account/);
    assert.equal((await Client.as(server.url, 'participant').request('POST', `${O}/voting/ballots/${ballot}/void`, { body: '{"reason":"x"}', type: 'application/json' })).status, 403);
  });

  test('the window holds in the backend, and the tally is published only after it closes', async () => {
    assert.equal((await org.request('POST', `${O}/voting/publish`, { body: '{}', type: 'application/json' })).status, 409, 'cannot publish while open');
    // Close the window: move it into the past. who-may-vote and max_picks are locked, so they stay the same.
    assert.equal((await org.postForm(`${O}/voting`, { opens_at: isoIn(-120), closes_at: isoIn(-1), access: 'accounts', max_picks: '2' })).status, 303);
    assert.equal((await org.postForm(`${O}/voting`, { opens_at: isoIn(-120), closes_at: isoIn(-1), access: 'codes', max_picks: '2' })).status, 422, 'access is fixed once ballots exist');
    const late = await signUp(server.url, 'Late Voter');
    const refused = await late.request('POST', `/events/${E}/vote`, { body: JSON.stringify({ pick: ['prj_02'] }), type: 'application/json' });
    assert.equal(refused.status, 409);
    assert.match(refused.text, /Voting closed/);
    assert.match((await new Client(server.url).get(`/events/${E}/vote/results`)).text, /Hidden for now/, 'closed but not yet published');

    assert.equal((await org.request('POST', `${O}/voting/publish`, { body: '{}', type: 'application/json' })).status, 200);
    const results = await new Client(server.url).getJson(`/api/events/${E}/vote`);
    const tally = results.json<{ phase: string; tally: { ballots: number; voided: number; rows: { votes: number }[] } }>();
    assert.equal(tally.phase, 'published');
    assert.equal(tally.tally.ballots, 2);
    assert.equal(tally.tally.voided, 1);
    assert.equal(tally.tally.rows.reduce((s, r) => s + r.votes, 0), store().get<{ n: number }>('SELECT count(*) AS n FROM ballot_picks k JOIN ballots b ON b.id = k.ballot_id WHERE b.voided_at IS NULL')?.n);
    assert.match((await new Client(server.url).get(`/events/${E}/vote/results`)).text, /Share of ballots/);
    assert.match((await new Client(server.url).get(`/events/${E}`)).text, /Community vote/);
  });
});

describe('community vote: one-time voter codes', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let org: Client;
  let codes: string[] = [];

  before(async () => {
    server = await startServer();
    org = Client.as(server.url, 'organizer');
    assert.equal((await org.postForm(`${O}/voting`, { opens_at: isoIn(-60), closes_at: isoIn(120), access: 'codes', max_picks: '3' })).status, 303);
    const created = await org.postForm(`${O}/voting/codes`, { count: '3' }, { tokenFrom: `${O}/voting` });
    assert.equal(created.status, 200);
    codes = [...created.text.matchAll(/<code>([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})<\/code>/g)].map((m) => m[1] as string);
  });
  after(() => server.close());

  test('codes are shown once and stored only as hashes', async () => {
    assert.equal(codes.length, 3);
    const stored = server.booted.store.all<{ code_hash: string }>('SELECT code_hash FROM voter_codes');
    assert.equal(stored.length, 3);
    for (const { code_hash } of stored) assert.ok(!codes.some((c) => code_hash.includes(c.replaceAll('-', ''))));
    assert.doesNotMatch((await org.get(`${O}/voting`)).text, new RegExp(codes[0] as string), 'not shown again');
  });

  test('a code opens one ballot, with no account; a spent or wrong code gets the same answer', async () => {
    const visitor = new Client(server.url);
    assert.match((await visitor.get(`/events/${E}/vote`)).text, /Your voter code/);
    const wrong = await visitor.postForm(`/events/${E}/vote/code`, { code: 'aaaa-bbbb-cccc' }, { tokenFrom: `/events/${E}/vote` });
    assert.equal(wrong.status, 422);
    const code = (codes[0] as string).toUpperCase().replaceAll('-', ' ');
    const ballot = await visitor.postForm(`/events/${E}/vote/code`, { code }, { tokenFrom: `/events/${E}/vote` });
    assert.equal(ballot.status, 200, 'codes are forgiving about case and separators');
    const picks = pickIds(ballot.text);
    assert.equal(picks.length, 40, 'a code voter has no team, so every live project is open');
    const cast = await visitor.postForm(`/events/${E}/vote`, { code, pick: picks.slice(0, 3) }, { tokenFrom: `/events/${E}/vote` });
    assert.equal(cast.status, 200);
    const reuse = await visitor.postForm(`/events/${E}/vote/code`, { code: codes[0] as string }, { tokenFrom: `/events/${E}/vote` });
    assert.equal(reuse.status, 422);
    assert.equal(reuse.text.includes('not valid for this vote, or it has been used'), wrong.text.includes('not valid for this vote, or it has been used'));
    assert.match((await org.get(`${O}/voting`)).text, /1 of 3 used/);
  });

  test('a venue behind one address is never throttled for valid codes', async () => {
    const created = await org.postForm(`${O}/voting/codes`, { count: '25' }, { tokenFrom: `${O}/voting` });
    const venue = [...created.text.matchAll(/<code>([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})<\/code>/g)].map((m) => m[1] as string);
    assert.equal(venue.length, 25);
    const attendee = new Client(server.url);
    const token = await attendee.csrfToken(`/events/${E}/vote`);
    for (const code of venue) {
      assert.equal((await attendee.postForm(`/events/${E}/vote/code`, { code, _csrf: token }, { csrf: false })).status, 200, 'only wrong codes count against an address');
    }
  });

  test('guessing codes is rate limited per address', async () => {
    const guesser = new Client(server.url);
    const token = await guesser.csrfToken(`/events/${E}/vote`);
    let last = 0;
    for (let i = 0; i < 61 && last !== 429; i++) {
      last = (await guesser.postForm(`/events/${E}/vote/code`, { code: `zzzz-zzzz-${String(i).padStart(4, 'z')}`, _csrf: token }, { csrf: false })).status;
    }
    assert.equal(last, 429);
  });
});

describe('comments on gallery projects', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let org: Client;
  let author: Client;
  const P = '/projects/prj_02';

  before(async () => {
    server = await startServer();
    org = Client.as(server.url, 'organizer');
    author = Client.as(server.url, 'participant');
  });
  after(() => server.close());

  test('a signed-in account comments; the text is escaped wherever it is shown', async () => {
    assert.equal((await new Client(server.url).postForm(`${P}/comments`, { body: 'hi' }, { tokenFrom: '/login' })).status, 401);
    assert.equal((await author.postForm(`${P}/comments`, { body: '<script>alert(1)</script> Nice work on the parser' }, { tokenFrom: P })).status, 303);
    const page = (await new Client(server.url).get(P)).text;
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Nice work on the parser/);
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
    assert.match(page, /Comments \(1\)/);
    assert.equal((await author.postForm('/projects/prj_07/comments', { body: 'on a replaced project' }, { tokenFrom: P })).status, 404, 'only public projects take comments');
  });

  test('another user cannot take a comment down; the attempt is audited', async () => {
    const id = /id="(cmt_[a-z0-9]+)"/.exec((await new Client(server.url).get(P)).text)?.[1];
    assert.ok(id);
    const judge = Client.as(server.url, 'judge_b');
    assert.equal((await judge.request('POST', `/comments/${id}/hide`, { body: '{}', type: 'application/json' })).status, 403);
    assert.match((await org.get(`${O}/audit?action=access.denied`)).text, /hide someone else(?:'|&#39;)s comment/);
  });

  test('an organizer hides with a reason: gone for the public, kept and marked for organizers', async () => {
    const id = /id="(cmt_[a-z0-9]+)"/.exec((await new Client(server.url).get(P)).text)?.[1] as string;
    assert.equal((await org.postForm(`/comments/${id}/hide`, { reason: '' }, { tokenFrom: P })).status, 422);
    assert.equal((await org.postForm(`/comments/${id}/hide`, { reason: 'Spam link' }, { tokenFrom: P })).status, 303);
    assert.doesNotMatch((await new Client(server.url).get(P)).text, /Nice work on the parser/);
    const organizerView = (await org.get(P)).text;
    assert.match(organizerView, /Nice work on the parser/);
    assert.match(organizerView, /Spam link/);
    assert.match((await org.get(`${O}/audit?action=comment`)).text, /hid a comment on .*Spam link/);
  });

  test('an author withdraws their own comment without giving a reason', async () => {
    assert.equal((await author.postForm(`${P}/comments`, { body: 'Second thoughts' }, { tokenFrom: P })).status, 303);
    const page = (await author.get(P)).text;
    const id = [...page.matchAll(/id="(cmt_[a-z0-9]+)"/g)].map((m) => m[1]).at(-1) as string;
    assert.equal((await author.postForm(`/comments/${id}/hide`, {}, { tokenFrom: P })).status, 303);
    assert.doesNotMatch((await new Client(server.url).get(P)).text, /Second thoughts/);
  });

  test('posting is rate limited per account', async () => {
    const spammer = Client.as(server.url, 'judge_a');
    const token = await spammer.csrfToken(P);
    let last = 0;
    for (let i = 0; i < 11 && last !== 429; i++) last = (await spammer.postForm(`${P}/comments`, { body: `comment ${i}`, _csrf: token }, { csrf: false })).status;
    assert.equal(last, 429);
  });
});
