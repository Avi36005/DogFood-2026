/**
 * Judge assignment planner. Pure: it takes the current state and returns the assignments to
 * add, so it can be tested without a database and re-run safely (existing assignments count).
 *
 * Rules, in priority order:
 *   1. A judge only reviews projects in tracks they cover (a judge with no tracks covers all).
 *   2. A judge never reviews a project from a team they are on (conflict of interest).
 *   3. A judge never gets the same project twice.
 *   4. Projects with the fewest reviews are served first, one slot per project per round,
 *      so a shortage is spread evenly instead of starving the projects at the end of the list.
 *   5. Among eligible judges, the least loaded one gets the slot. Ties are broken by a hash of
 *      (seed, project, judge), which is deterministic but not alphabetical, so jdg_01 does not
 *      absorb every tie.
 */

export interface PlanProject {
  id: string;
  trackId: string | null;
  assignedJudges: ReadonlySet<string>;
  conflictedJudges: ReadonlySet<string>;
}

export interface PlanJudge {
  id: string;
  trackIds: ReadonlySet<string>;
  load: number;
}

export interface PlanOptions {
  target: number;
  maxLoad?: number;
  seed: string;
}

export interface Shortfall {
  projectId: string;
  have: number;
  missing: number;
  reason: string;
}

export interface Plan {
  assignments: { projectId: string; judgeId: string }[];
  shortfalls: Shortfall[];
}

export function covers(judge: PlanJudge, project: PlanProject): boolean {
  return judge.trackIds.size === 0 || project.trackId === null || judge.trackIds.has(project.trackId);
}

export function planAssignments(projects: readonly PlanProject[], judges: readonly PlanJudge[], options: PlanOptions): Plan {
  const load = new Map(judges.map((j) => [j.id, j.load]));
  const assigned = new Map(projects.map((p) => [p.id, new Set(p.assignedJudges)]));
  const added: Plan['assignments'] = [];
  const eligible = (project: PlanProject, judge: PlanJudge) =>
    covers(judge, project) && !project.conflictedJudges.has(judge.id) && !assigned.get(project.id)?.has(judge.id);

  let progress = true;
  while (progress) {
    progress = false;
    const queue = projects
      .filter((p) => (assigned.get(p.id)?.size ?? 0) < options.target)
      .sort((x, y) => (assigned.get(x.id)?.size ?? 0) - (assigned.get(y.id)?.size ?? 0) || x.id.localeCompare(y.id));
    for (const project of queue) {
      if ((assigned.get(project.id)?.size ?? 0) >= options.target) continue;
      let best: PlanJudge | null = null;
      let bestKey: [number, number] = [Infinity, Infinity];
      for (const judge of judges) {
        const current = load.get(judge.id) ?? 0;
        if (!eligible(project, judge)) continue;
        if (options.maxLoad !== undefined && current >= options.maxLoad) continue;
        const key: [number, number] = [current, tieBreak(options.seed, project.id, judge.id)];
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          best = judge;
          bestKey = key;
        }
      }
      if (!best) continue;
      assigned.get(project.id)?.add(best.id);
      load.set(best.id, (load.get(best.id) ?? 0) + 1);
      added.push({ projectId: project.id, judgeId: best.id });
      progress = true;
    }
  }

  const shortfalls: Shortfall[] = [];
  for (const project of projects) {
    const have = assigned.get(project.id)?.size ?? 0;
    if (have >= options.target) continue;
    const coverable = judges.filter((j) => covers(j, project) && !project.conflictedJudges.has(j.id)).length;
    shortfalls.push({
      projectId: project.id,
      have,
      missing: options.target - have,
      reason:
        coverable < options.target
          ? `only ${coverable} judge(s) cover this track without a conflict`
          : 'every eligible judge has reached the load limit',
    });
  }
  return { assignments: added, shortfalls };
}

/** FNV-1a: a small, stable string hash. Not for security; only for fair, repeatable tie-breaks. */
function tieBreak(seed: string, projectId: string, judgeId: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `${seed}\u0000${projectId}\u0000${judgeId}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
