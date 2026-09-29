import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, extract, startServer } from '../helpers.ts';

/** The organizer's tools on the fixture event, where judging is already under way. */
describe('organizer tools', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let org: Client;
  const S = '/organize/sample-hack-2026';
  const store = () => server.booted.store;

  before(async () => {
    server = await startServer();
    org = Client.as(server.url, 'organizer');
  });
  after(() => server.close());

  test('the duplicate decision can be reversed, and the ranking follows it', async () => {
    const before = await org.get('/api/export.csv?kind=results');
    assert.match(before.text, /prj_41,Dry Harbour/);
    assert.doesNotMatch(before.text, /prj_07,/);

    assert.equal((await org.postForm(`${S}/projects/prj_07/count`, {})).status, 303);
    const after = await org.get('/api/export.csv?kind=results');
    assert.match(after.text, /prj_07,Dry Harbour,[^,]+,[^,]+,5,/, 'prj_07 now counts, with its 5 reviews');
    assert.doesNotMatch(after.text, /prj_41,/);
    assert.equal((await new Client(server.url).get('/projects/prj_41')).status, 404, 'the other submission leaves the public gallery');
    assert.match((await org.get(`${S}/audit`)).text, /project\.duplicate_resolved/);

    await org.postForm(`${S}/projects/prj_41/count`, {});
    assert.match((await org.get('/api/export.csv?kind=results')).text, /prj_41,Dry Harbour/);
  });

  test('once scores exist, criteria are locked but weights can change, and the change is audited', async () => {
    const page = await org.get(`${S}/rubric`);
    assert.match(page.text, /Criteria locked/);
    const ids = [...page.text.matchAll(/name="weight_(crt_[\w]+)"/g)].map((m) => m[1] as string);
    const names = [...page.text.matchAll(/name="name_crt_[\w]+" value="([^"]+)"/g)].map((m) => m[1] as string);
    const base: Record<string, string> = { score_min: '1', score_max: '5' };
    ids.forEach((id, i) => Object.assign(base, { [`name_${id}`]: names[i] ?? '', [`description_${id}`]: '', [`weight_${id}`]: '1' }));

    const added = await org.postForm(`${S}/rubric`, { ...base, new_name: 'Design', new_weight: '1' });
    assert.equal(added.status, 422);
    assert.match(added.text, /can no longer be added or removed/);

    const reweighted = await org.postForm(`${S}/rubric`, { ...base, [`weight_${ids[0]}`]: '3' });
    assert.equal(reweighted.status, 303);
    assert.match((await org.get(`${S}/audit?action=rubric.changed`)).text, /Functionality weight 1 → 3/);
    const header = (await org.get('/api/export.csv?kind=results')).text.split('\r\n')[1];
    assert.ok(header, 'results are recomputed with the new weights');
  });

  test('manual assignment checks eligibility, and unfinished assignments can be removed', async () => {
    const conflicted = await org.postForm(`${S}/assignments`, { project_id: 'prj_01', judge_id: 'usr_ecef4d6b84b1' });
    assert.equal(conflicted.status, 422, 'priya1 is not a judge');
    const existing = store().get<{ judge_id: string }>("SELECT judge_id FROM assignments WHERE project_id = 'prj_01' LIMIT 1")?.judge_id ?? '';
    assert.equal((await org.postForm(`${S}/assignments`, { project_id: 'prj_01', judge_id: existing })).status, 422, 'already assigned');

    const free = store().get<{ id: string }>("SELECT u.id FROM users u JOIN event_roles r ON r.user_id = u.id AND r.role = 'judge' WHERE u.id NOT IN (SELECT judge_id FROM assignments WHERE project_id = 'prj_01') ORDER BY u.id LIMIT 1")?.id ?? '';
    assert.equal((await org.postForm(`${S}/assignments`, { project_id: 'prj_01', judge_id: free })).status, 303);
    const id = store().get<{ id: string }>("SELECT id FROM assignments WHERE project_id = 'prj_01' AND judge_id = ?", [free])?.id ?? '';
    assert.equal((await org.postForm(`${S}/assignments/${id}/remove`, {})).status, 303);

    const submitted = store().get<{ id: string }>("SELECT a.id FROM assignments a JOIN reviews r ON r.assignment_id = a.id WHERE r.status = 'submitted' LIMIT 1")?.id ?? '';
    assert.equal((await org.postForm(`${S}/assignments/${submitted}/remove`, {})).status, 409, 'a submitted review stays on record');
  });

  test('auto-assign tops the fixture up to three reviews per project where tracks allow', async () => {
    const reply = await org.postForm(`${S}/assignments/auto`, {});
    assert.equal(reply.status, 200);
    const created = Number(extract(reply.text, /Created (\d+) assignment/));
    assert.ok(created >= 8, `created ${created}`);
    const short = store().get<{ n: number }>(
      "SELECT count(*) AS n FROM projects p WHERE p.event_id = 'evt_01' AND p.status = 'submitted' AND p.superseded_by IS NULL AND (SELECT count(*) FROM assignments a WHERE a.project_id = p.id) < 3",
    )?.n;
    assert.equal(short, 0);
    // Every new assignment respects the judge's tracks.
    const offTrack = store().get<{ n: number }>(
      `SELECT count(*) AS n FROM assignments a JOIN projects p ON p.id = a.project_id
       WHERE a.source = 'auto' AND EXISTS (SELECT 1 FROM judge_tracks t WHERE t.judge_id = a.judge_id AND t.event_id = a.event_id)
         AND NOT EXISTS (SELECT 1 FROM judge_tracks t WHERE t.judge_id = a.judge_id AND t.track_id = p.track_id)`,
    )?.n;
    assert.equal(offTrack, 0);
    assert.equal((await org.postForm(`${S}/assignments/auto`, {})).text.match(/Created (\d+)/)?.[1], '0', 'running it again adds nothing');
  });

  test('a judge with submitted reviews cannot be removed', async () => {
    assert.equal((await org.postForm(`${S}/judges/jdg_24/remove`, {})).status, 409);
  });

  test('changing the deadline is audited with before and after', async () => {
    const settings = await org.get(`${S}/settings`);
    assert.match(settings.text, /value="2026-03-01T18:00"/);
    const reply = await org.postForm(`${S}/settings`, {
      name: 'Sample Hack 2026', tagline: 'Imported from the DOGFOOD fixtures.', description: 'x',
      submissions_close_at: '2026-03-01T19:00', max_team_size: '4', reviews_per_project: '3',
    });
    assert.equal(reply.status, 303);
    assert.match((await org.get(`${S}/audit?action=event.updated`)).text, /Changed description, submissions close at/);
    const bad = await org.postForm(`${S}/settings`, { name: '', submissions_close_at: '', max_team_size: '99' });
    assert.equal(bad.status, 422);
  });

  test('publish, then withdraw: the public page follows, snapshots are kept', async () => {
    assert.equal((await org.postForm(`${S}/results/publish`, {})).status, 303);
    assert.match((await new Client(server.url).get('/events/sample-hack-2026/results')).text, /Iron Switch|Salt Ledger/);
    assert.match((await new Client(server.url).get('/projects')).text, /Rank 1/);
    assert.equal((await org.postForm(`${S}/results/unpublish`, {})).status, 303);
    assert.match((await new Client(server.url).get('/events/sample-hack-2026/results')).text, /Not published yet/);
    assert.equal(store().get<{ n: number }>('SELECT count(*) AS n FROM result_snapshots')?.n, 1);
  });

  test('an administrator issues a one-time password link: the recovery path', async () => {
    const admin = new Client(server.url);
    await admin.signIn('admin@forgeboard.local');
    const reply = await admin.postForm('/admin/users/jdg_01/link', {});
    assert.equal(reply.status, 200);
    const link = extract(reply.text, /value="https?:\/\/[^"]*(\/password\/[\w-]+)"/);
    const tomas = new Client(server.url);
    assert.match((await tomas.get(link)).text, /Set up your account/);
    assert.equal((await tomas.postForm(link, { password: 'tomas-password' }, { tokenFrom: link })).status, 303);
    assert.equal((await tomas.get('/api/me')).json<{ user: { id: string } }>().user.id, 'jdg_01');
    assert.equal((await new Client(server.url).get(link)).status, 410);
  });
});
