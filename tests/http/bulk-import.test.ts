import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, startServer } from '../helpers.ts';

/** T4 bulk import: many judges from CSV, all or nothing, with the single-invite rules per row. */

describe('bulk judge import (T4)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const S = 'sample-hack-2026';
  const URL_ = `/organize/${S}/judges/import`;
  const post = (client: Client, csv: string) => client.request('POST', URL_, { body: JSON.stringify({ csv }), type: 'application/json', headers: { accept: 'application/json' } });
  const judges = () => server.booted.store.get<{ n: number }>("SELECT count(*) AS n FROM event_roles WHERE event_id = 'evt_01' AND role = 'judge'")?.n ?? 0;
  const organizer = () => Client.as(server.url, 'organizer');
  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  test('three judges in one go: header skipped, tracks by name, by id, or every track', async () => {
    const before = judges();
    const reply = await post(organizer(), 'name,email,tracks\nAda Lovelace,ada.import@example.org,Developer tools\nAlan Turing,alan.import@example.org,trk_02;trk_03\nGrace Hopper,grace.import@example.org,');
    assert.equal(reply.status, 201);
    const body = reply.json<{ imported: number; judges: { email: string; invite_url: string }[] }>();
    assert.equal(body.imported, 3);
    assert.equal(judges(), before + 3);
    const tracks = (email: string) => server.booted.store.all<{ track_id: string }>('SELECT t.track_id FROM judge_tracks t JOIN users u ON u.id = t.judge_id WHERE u.email = ? ORDER BY t.track_id', [email]).map((r) => r.track_id);
    assert.deepEqual(tracks('ada.import@example.org'), ['trk_01']);
    assert.deepEqual(tracks('alan.import@example.org'), ['trk_02', 'trk_03']);
    assert.deepEqual(tracks('grace.import@example.org'), []);
    assert.equal(server.booted.store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'judge.bulk_imported'")?.n, 1);
    for (const judge of body.judges) {
      const invite = await new Client(server.url).get(new URL(judge.invite_url).pathname);
      assert.equal(invite.status, 200, `${judge.email}'s one-time link works`);
    }
  });

  for (const [name, csv, says] of [
    ['an unknown track', 'Bad Track,bad.track@example.org,Underwater basket weaving', /line 1: no track called Underwater basket weaving/],
    ['an email twice', 'One,twice@example.org,\nTwo,twice@example.org,', /line 2: twice@example\.org appears twice/],
    ['a malformed email', 'Nobody,not-an-email,', /line 1:/],
    ['too many columns', 'A,a.cols@example.org,trk_01,extra', /line 1: expected name,email,tracks/],
    ['someone who is on a team in this event', 'Priya,priya1@example.org,', /line 1: This person is on a team in this event/],
    ['nothing at all', '\n\n', /Paste at least one line/],
  ] as [string, string, RegExp][]) {
    test(`${name}: refused, the line named, and nothing imported`, async () => {
      const before = judges();
      const good = 'Fine Person,fine.person.' + Math.random().toString(36).slice(2, 8) + '@example.org,';
      const reply = await post(organizer(), `${csv.trim() ? `${csv}\n${good}` : csv}`);
      assert.equal(reply.status, 422);
      const message = reply.json<{ fields: { csv: string } }>().fields.csv;
      assert.match(message, says);
      if (csv.trim()) assert.match(message, /^Nothing was imported\./);
      assert.equal(judges(), before, 'all or nothing');
    });
  }

  for (const [who, client, status] of [
    ['a visitor', () => new Client(server.url), 401],
    ['a participant', () => Client.as(server.url, 'participant'), 403],
    ['judge A', () => Client.as(server.url, 'judge_a'), 403],
  ] as [string, () => Client, number][]) {
    test(`${who} cannot import (${status})`, async () => {
      const before = judges();
      assert.equal((await post(client(), 'Sneaky,sneaky@example.org,')).status, status);
      assert.equal(judges(), before);
    });
  }

  test('the form on the judges page imports and lists the links', async () => {
    const reply = await organizer().postForm(URL_, { csv: 'Form Judge,form.judge@example.org,' }, { tokenFrom: `/organize/${S}/judges` });
    assert.equal(reply.status, 201);
    assert.match(reply.text, /1 judge\(s\) imported/);
    assert.match(reply.text, /form\.judge@example\.org/);
  });
});
