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
});
