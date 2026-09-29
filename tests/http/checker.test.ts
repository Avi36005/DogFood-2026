import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, startServer } from '../helpers.ts';

/**
 * The seven requests the official DOGFOOD checker (run.py) makes, reproduced as our own tests
 * so a regression fails here before anyone runs the checker, plus the reasons behind each answer.
 */
describe('the DOGFOOD acceptance behaviours', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const as = (role: 'organizer' | 'judge_a' | 'judge_b' | 'participant') => Client.as(server.url, role);
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('T1: a stranger can browse the gallery', async () => {
    const reply = await new Client(server.url).get('/projects');
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type') ?? '', /text\/html/);
  });

  test('T1: the gallery shows the first fixture projects in the server-rendered HTML', async () => {
    const { text } = await new Client(server.url).get('/projects');
    for (const title of ['Glass Signal', 'Small Meadow', 'Deep Compass']) assert.ok(text.includes(title), title);
    assert.ok(!text.includes('prj_07'), 'the replaced duplicate is not listed');
    assert.equal((text.match(/class="card project-card"/g) ?? []).length, 40, 'all 40 current projects on page one');
  });

  test('T1: the closed fixture event refuses a submission, and the deadline is the reason', async () => {
    const reply = await as('participant').postJson('/projects/new', { title: 'dogfood-late-submission-probe', summary: 'probe' });
    assert.equal(reply.status, 403);
    assert.match(reply.json<{ error: string }>().error, /closed on 1 Mar 2026, 18:00 UTC/);
  });

  test('T2: judge A reads their own scores', async () => {
    const reply = await as('judge_a').get('/api/judge/scores');
    assert.equal(reply.status, 200);
    const body = reply.json<{ judge: { id: string }; scores: { criteria: Record<string, number> }[] }>();
    assert.equal(body.judge.id, 'jdg_24');
    assert.equal(body.scores.length, 11);
    assert.deepEqual(Object.keys(body.scores[0]?.criteria ?? {}).sort(), ['functionality', 'innovation', 'quality']);
  });

  test("T2: judge B is refused judge A's scores, whether or not the id exists", async () => {
    for (const probe of ['jdg_24', 'jdg_99', 'usr_nobody']) {
      const reply = await as('judge_b').get(`/api/judge/scores?judge=${probe}`);
      assert.equal(reply.status, 403, probe);
      assert.doesNotMatch(reply.text, /Diego|functionality/, 'no data leaks in the refusal');
    }
  });

  test('T2: a participant is not a judge', async () => {
    assert.equal((await as('participant').get('/api/judge/scores')).status, 403);
    assert.equal((await new Client(server.url).get('/api/judge/scores')).status, 401);
  });

  test('T2: the organizer exports CSV with a header row', async () => {
    const reply = await as('organizer').get('/api/export.csv');
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type') ?? '', /text\/csv/);
    const [header, first] = reply.text.split('\r\n');
    assert.equal(header, 'rank,project_id,title,team,track,reviews,raw_mean,normalized_score,raw_rank,low_coverage,rank_lo_90,rank_hi_90,top3_share,status');
    assert.match(first ?? '', /^1,prj_34,Iron Switch,/);
  });

  test('refusals are on the audit trail, readable by the organizer', async () => {
    await as('judge_b').get('/api/judge/scores?judge=jdg_24');
    const reply = await as('organizer').get('/organize/sample-hack-2026/audit?action=access.denied');
    assert.equal(reply.status, 200);
    assert.match(reply.text, /Ines Rocha &lt;ines.rocha@example.org&gt; was refused the scores of another judge \(jdg_24\)/);
    assert.match(reply.text, /priya1 &lt;priya1@example.org&gt; was refused judge scores/);
  });

  test('an organizer may read any judge of their event', async () => {
    const reply = await as('organizer').get('/api/judge/scores?judge=jdg_24');
    assert.equal(reply.status, 200);
    assert.equal(reply.json<{ scores: unknown[] }>().scores.length, 11);
  });
});
