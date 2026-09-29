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

