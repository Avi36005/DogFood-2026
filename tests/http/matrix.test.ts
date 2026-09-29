import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createSession } from '../../src/domain/sessions.ts';
import { Client, startServer } from '../helpers.ts';

type Who = 'anon' | 'participant' | 'judge_a' | 'judge_b' | 'organizer' | 'admin';
const WHO: Who[] = ['anon', 'participant', 'judge_a', 'judge_b', 'organizer', 'admin'];

/**
 * Every role against every protected route, asserting the status, not just printing it.
 * HTML pages send a signed-out visitor to the sign-in page (303); the API answers 401.
 * POSTs go as JSON, the path a script or curl would take; forms are covered in security tests.
 * The admin row follows the organizers' FIG. 02: an instance administrator may read peer
 * scores, other tracks, aggregates and the audit log in every event (and each use is audited).
 */
describe('authorization matrix', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let ownReview = '';
  let otherReview = '';
  let adminSession = '';
  const client = (who: Who) => (who === 'anon' ? new Client(server.url) : who === 'admin' ? new Client(server.url, adminSession) : Client.as(server.url, who));

  before(async () => {
    server = await startServer();
    ownReview = server.booted.store.get<{ id: string }>("SELECT id FROM assignments WHERE judge_id = 'jdg_24' ORDER BY id LIMIT 1")?.id ?? '';
    otherReview = server.booted.store.get<{ id: string }>("SELECT id FROM assignments WHERE judge_id = 'jdg_03' ORDER BY id LIMIT 1")?.id ?? '';
    adminSession = createSession(server.booted.store, 'usr_demo_admin', new Date());
  });
  after(() => server.close());

  const S = 'sample-hack-2026';
  const gets: [string, Record<Who, number>][] = [
    ['/api/judge/scores', { anon: 401, participant: 403, judge_a: 200, judge_b: 200, organizer: 403 , admin: 403 }],
    ['/api/judge/scores?judge=jdg_24', { anon: 401, participant: 403, judge_a: 200, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/judge/scores?judge=jdg_03', { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/export.csv', { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/export.csv?event=evt_01&kind=reviews', { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/export.csv?event=evt_01&kind=audit', { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/events/evt_01/progress', { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/api/me', { anon: 401, participant: 200, judge_a: 200, judge_b: 200, organizer: 200 , admin: 200 }],
    [`/judge/${S}`, { anon: 303, participant: 403, judge_a: 200, judge_b: 200, organizer: 403 , admin: 403 }],
    ['/judge/reviews/OWN', { anon: 303, participant: 403, judge_a: 200, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/judge/reviews/OTHER', { anon: 303, participant: 403, judge_a: 403, judge_b: 403, organizer: 200 , admin: 200 }],
    ['/judge/reviews/asg_does_not_exist', { anon: 303, participant: 403, judge_a: 403, judge_b: 403, organizer: 403 , admin: 403 }],
    ...['', '/progress', '/settings', '/rubric', '/judges', '/assignments', '/projects', '/results', '/audit', '/export'].map(
      (tab): [string, Record<Who, number>] => [`/organize/${S}${tab}`, { anon: 303, participant: 403, judge_a: 403, judge_b: 403, organizer: 200, admin: 200 }],
    ),
    ['/admin', { anon: 303, participant: 403, judge_a: 403, judge_b: 403, organizer: 403 , admin: 200 }],
    ['/events/new', { anon: 303, participant: 403, judge_a: 403, judge_b: 403, organizer: 403 , admin: 200 }],
    ['/projects/prj_07', { anon: 404, participant: 404, judge_a: 404, judge_b: 404, organizer: 200 , admin: 200 }],
    ['/projects/prj_01', { anon: 200, participant: 200, judge_a: 200, judge_b: 200, organizer: 200 , admin: 200 }],
    [`/events/${S}/results`, { anon: 200, participant: 200, judge_a: 200, judge_b: 200, organizer: 200 , admin: 200 }],
  ];

  // One test per cell, so a failure names the exact route and role.
  for (const [path, expected] of gets) {
    for (const who of WHO) {
      test(`GET ${path} as ${who} → ${expected[who]}`, async () => {
        const url = path.replace('OWN', ownReview).replace('OTHER', otherReview);
        assert.equal((await client(who).get(url)).status, expected[who], `${who} → ${url}`);
      });
    }
  }

  const posts: [string, unknown, Partial<Record<Who, number>>][] = [
    ['/judge/reviews/OTHER', { intent: 'submit', score_functionality: 5 }, { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 403, admin: 403 }],
    [`/organize/${S}/results/publish`, {}, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    [`/organize/${S}/assignments/auto`, {}, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    [`/organize/${S}/rubric`, { new_name: 'Hacked' }, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    [`/organize/${S}/judges`, { name: 'X', email: 'x@example.org' }, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    [`/organize/${S}/close-submissions`, {}, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    [`/organize/${S}/projects/prj_07/count`, {}, { anon: 401, participant: 403, judge_a: 403, judge_b: 403 }],
    ['/events/new', { name: 'X', submissions_close_at: '2030-01-01T00:00' }, { anon: 401, participant: 403, judge_a: 403, judge_b: 403, organizer: 403 }],
    ['/projects/prj_02/edit', { title: 'Taken over' }, { anon: 403, participant: 403, judge_a: 403, judge_b: 403, organizer: 403, admin: 403 }],
    ['/projects/new', { title: 'Late' }, { anon: 401, participant: 403 }],
  ];

  for (const [path, body, expected] of posts) {
    for (const [who, status] of Object.entries(expected)) {
      test(`POST ${path} as ${who} → ${status}`, async () => {
        const url = path.replace('OTHER', otherReview);
        assert.equal((await client(who as Who).postJson(url, body)).status, status, `${who} → ${url}`);
      });
    }
  }

  test("the administrator's reads are on the event's audit trail; the organizer's are not", () => {
    const store = server.booted.store;
    const entries = store.all<{ actor_id: string; summary: string }>("SELECT actor_id, summary FROM audit_log WHERE event_id = 'evt_01' AND action = 'admin.access'");
    assert.ok(entries.length >= 10, `${entries.length} admin.access entries`);
    assert.ok(entries.every((e) => e.actor_id === 'usr_demo_admin'));
    assert.ok(entries.some((e) => /read the scores of jdg_03/.test(e.summary)));
    assert.ok(entries.some((e) => /read another judge's review/.test(e.summary)));
  });

  test('nothing in the matrix changed any data', () => {
    const store = server.booted.store;
    assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM criteria WHERE key = 'hacked'")?.n, 0);
    assert.equal(store.get<{ p: string | null }>("SELECT results_published_at AS p FROM events WHERE id = 'evt_01'")?.p, null);
    assert.equal(store.get<{ t: string }>("SELECT title AS t FROM projects WHERE id = 'prj_02'")?.t, 'Small Meadow');
  });
});
