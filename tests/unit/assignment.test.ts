import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planAssignments, type PlanJudge, type PlanProject } from '../../src/domain/assignment.ts';

const project = (id: string, trackId: string | null, extra: Partial<PlanProject> = {}): PlanProject => ({
  id, trackId, assignedJudges: new Set(), conflictedJudges: new Set(), ...extra,
});
const judge = (id: string, tracks: string[] = [], load = 0): PlanJudge => ({ id, trackIds: new Set(tracks), load });

describe('planAssignments', () => {
  test('reaches the target for every project when judges allow it', () => {
    const projects = ['p1', 'p2', 'p3', 'p4'].map((id) => project(id, 't'));
    const judges = ['j1', 'j2', 'j3'].map((id) => judge(id, ['t']));
    const plan = planAssignments(projects, judges, { target: 2, seed: 's' });
    assert.equal(plan.assignments.length, 8);
    assert.equal(plan.shortfalls.length, 0);
    for (const p of projects) assert.equal(plan.assignments.filter((a) => a.projectId === p.id).length, 2);
  });

  test('balances load: no judge carries more than one extra', () => {
    const projects = Array.from({ length: 10 }, (_, i) => project(`p${i}`, 't'));
    const judges = ['a', 'b', 'c', 'd'].map((id) => judge(id, ['t']));
    const plan = planAssignments(projects, judges, { target: 3, seed: 's' });
    const loads = judges.map((j) => plan.assignments.filter((a) => a.judgeId === j.id).length);
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 1, `loads ${loads}`);
  });

  test('only uses judges who cover the track; a judge with no tracks covers all', () => {
    const plan = planAssignments([project('p', 'robots')], [judge('art', ['art']), judge('bots', ['robots']), judge('any')], { target: 3, seed: 's' });
    assert.deepEqual(plan.assignments.map((a) => a.judgeId).sort(), ['any', 'bots']);
    assert.equal(plan.shortfalls[0]?.missing, 1);
    assert.match(plan.shortfalls[0]?.reason ?? '', /only 2 judge/);
  });

  test('never assigns a judge to their own team', () => {
    const plan = planAssignments([project('p', null, { conflictedJudges: new Set(['me']) })], [judge('me'), judge('other')], { target: 2, seed: 's' });
    assert.deepEqual(plan.assignments.map((a) => a.judgeId), ['other']);
  });

  test('keeps existing assignments and counts them toward the target and load', () => {
    const projects = [project('p1', null, { assignedJudges: new Set(['a']) }), project('p2', null)];
    const plan = planAssignments(projects, [judge('a', [], 1), judge('b')], { target: 1, seed: 's' });
    assert.deepEqual(plan.assignments, [{ projectId: 'p2', judgeId: 'b' }]);
  });

  test('respects a load limit and says why a project is short', () => {
    const plan = planAssignments([project('p1', null), project('p2', null)], [judge('a')], { target: 1, maxLoad: 1, seed: 's' });
    assert.equal(plan.assignments.length, 1);
    assert.match(plan.shortfalls[0]?.reason ?? '', /load limit/);
  });

  test('serves the least-covered projects first, so a shortage is shared', () => {
    // Two judges, three projects, target 2: 4 slots for 6 needed. Round-robin gives everyone at least one.
    const plan = planAssignments(['p1', 'p2', 'p3'].map((id) => project(id, null)), [judge('a'), judge('b')], { target: 2, maxLoad: 2, seed: 's' });
    for (const id of ['p1', 'p2', 'p3']) assert.ok(plan.assignments.some((a) => a.projectId === id), `${id} got nothing`);
  });

  test('is deterministic for a seed', () => {
    const projects = Array.from({ length: 6 }, (_, i) => project(`p${i}`, null));
    const judges = ['a', 'b', 'c'].map((id) => judge(id));
    assert.deepEqual(planAssignments(projects, judges, { target: 2, seed: 'x' }), planAssignments(projects, judges, { target: 2, seed: 'x' }));
  });
});
