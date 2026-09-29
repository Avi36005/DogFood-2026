import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { EXPORT_KINDS } from '../../src/domain/exports.ts';
import { createSession } from '../../src/domain/sessions.ts';
import { Client, FIXTURES, startServer } from '../helpers.ts';

/**
 * The fixture through the JSON API and the exports, one test per item: every project as the
 * public sees it, every track filter, every judge's scores as the organizer and as an administrator
 * read them (the FIG. 02 rows), and every export kind against every role. Expected values come
 * from fixtures.json.
 */

interface FixtureData {
  tracks: { id: string; name: string }[];
  judges: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  projects: { id: string; title: string; team: string; track: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number> }[];
}
const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) as FixtureData;
const DUPLICATE = 'prj_07';
const trackName = new Map(fixture.tracks.map((t) => [t.id, t.name]));
const teamName = new Map(fixture.teams.map((t) => [t.id, t.name]));

describe('the fixture through the API and exports, item by item', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let admin: Client;
  let organizer: Client;
  const anon = () => new Client(server.url);

  before(async () => {
    server = await startServer();
    admin = new Client(server.url, createSession(server.booted.store, 'usr_demo_admin', new Date()));
    organizer = Client.as(server.url, 'organizer');
  });
  after(() => server.close());

  describe('every project, as the public API shows it', () => {
    for (const project of fixture.projects) {
      test(`GET /api/projects/${project.id}`, async () => {
        const reply = await anon().getJson(`/api/projects/${project.id}`);
        if (project.id === DUPLICATE) {
          assert.equal(reply.status, 404, 'the superseded duplicate is not public');
          return;
        }
        assert.equal(reply.status, 200);
        const body = reply.json<{ project: { title: string; status: string }; team: { name: string }; track: string | null; event: string }>();
        assert.equal(body.project.title, project.title);
        assert.equal(body.project.status, 'submitted');
        assert.equal(body.team.name, teamName.get(project.team));
        assert.equal(body.track, trackName.get(project.track));
        assert.equal(body.event, 'sample-hack-2026');
        assert.doesNotMatch(reply.text, /jdg_\d\d|"criteria"|"comment"/, 'no review data in a public project');
      });
    }
  });

  describe('every track filter returns exactly its projects', () => {
    for (const track of fixture.tracks) {
      test(`GET /api/projects?track=${track.id} (${track.name})`, async () => {
        const reply = await anon().getJson(`/api/projects?track=${track.id}`);
        assert.equal(reply.status, 200);
        const ids = reply.json<{ items: { id: string; track: string }[] }>().items.map((p) => p.id).sort();
        const expected = fixture.projects.filter((p) => p.track === track.id && p.id !== DUPLICATE).map((p) => p.id).sort();
        assert.deepEqual(ids, expected);
      });
    }
  });

  describe("the organizer reads every judge's scores, exactly as filed", () => {
    for (const judge of fixture.judges) {
      test(`${judge.id} (${judge.name})`, async () => {
        const reply = await organizer.getJson(`/api/judge/scores?judge=${judge.id}`);
        assert.equal(reply.status, 200);
        const body = reply.json<{ judge: { id: string }; scores: { project_id: string; criteria: Record<string, number> }[] }>();
        assert.equal(body.judge.id, judge.id);
        const filed = fixture.scores.filter((s) => s.judge === judge.id);
        assert.equal(body.scores.length, filed.length);
        for (const s of filed) assert.deepEqual(body.scores.find((e) => e.project_id === s.project)?.criteria, s.criteria, s.project);
      });
    }
  });

  describe("an administrator reads every judge's scores too (FIG. 02), and each read is audited", () => {
    for (const judge of fixture.judges) {
      test(`${judge.id}`, async () => {
        const store = server.booted.store;
        const count = () => store.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.access' AND summary LIKE ?", [`%read the scores of ${judge.id}%`])?.n ?? 0;
        const before = count();
        const reply = await admin.getJson(`/api/judge/scores?judge=${judge.id}`);
        assert.equal(reply.status, 200);
        assert.equal(reply.json<{ scores: unknown[] }>().scores.length, fixture.scores.filter((s) => s.judge === judge.id).length);
        assert.equal(count(), before + 1, 'one admin.access entry for this read');
      });
    }
  });

  describe('every export kind, as every role', () => {
    const who: [string, () => Client, number][] = [
      ['a visitor', () => anon(), 401],
      ['a participant', () => Client.as(server.url, 'participant'), 403],
      ['judge A', () => Client.as(server.url, 'judge_a'), 403],
      ['judge B', () => Client.as(server.url, 'judge_b'), 403],
      ['the organizer', () => organizer, 200],
      ['an administrator (audited)', () => admin, 200],
    ];
    for (const kind of EXPORT_KINDS) {
      for (const [name, client, status] of who) {
        test(`${kind}.csv for ${name} → ${status}`, async () => {
          const reply = await client().get(`/api/export.csv?event=evt_01&kind=${kind}`);
          assert.equal(reply.status, status);
          if (status === 200) {
            assert.match(reply.headers.get('content-type') ?? '', /text\/csv/);
            assert.match(reply.text.split('\n')[0] ?? '', /,/, 'a CSV header line');
          } else {
            assert.doesNotMatch(reply.text, /^[a-z_]+,[a-z_]+/, 'no CSV body on a refusal');
          }
        });
      }
    }
  });
});
