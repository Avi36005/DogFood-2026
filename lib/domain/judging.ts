import { createHash } from "node:crypto";
import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import {
  AccessDenied, hasConflict, requireJudge, requireOrganizer, type Capability,
} from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";
import { byId as eventById, judgingOpen } from "./events.ts";
import { weightedScore, weightedScore100, isComplete } from "./scoring.ts";

export type RubricRow = { id: string; event_id: string; version: number; name: string; status: string; created_at: string; published_at: string | null };
export type CriterionRow = { id: string; rubric_version_id: string; name: string; description: string; weight: number; scale_min: number; scale_max: number; sort_order: number };
export type AssignmentRow = { id: string; event_id: string; project_id: string; judge_user_id: string; status: string; batch_label: string; assigned_at: string; revoked_at: string | null };

// ------------------------------------------------------------------ rubric --

export function publishedRubric(eventId: string): RubricRow | undefined {
  return get<RubricRow>(
    `SELECT * FROM rubric_versions WHERE event_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`,
    eventId,
  );
}

export function rubricById(id: string): RubricRow | undefined {
  return get<RubricRow>(`SELECT * FROM rubric_versions WHERE id = ?`, id);
}

export function criteria(rubricVersionId: string): CriterionRow[] {
  return all<CriterionRow>(`SELECT * FROM criteria WHERE rubric_version_id = ? ORDER BY sort_order, name`, rubricVersionId);
}

export function draftRubric(eventId: string): RubricRow | undefined {
  return get<RubricRow>(
    `SELECT * FROM rubric_versions WHERE event_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1`, eventId);
}

export function createRubricVersion(cap: Capability, name: string, items: { name: string; description?: string; weight: number; scaleMin?: number; scaleMax?: number }[]): RubricRow {
  requireOrganizer(cap);
  if (items.length === 0) throw new Error("A rubric needs at least one criterion.");
  if (items.some((i) => !i.name?.trim())) throw new Error("Every criterion needs a name.");
  // NaN slips past `< 0`, and an Infinity weight turns every weighted score into NaN.
  if (items.some((i) => !Number.isFinite(i.weight))) throw new Error("Every weight must be a finite number.");
  if (items.some((i) => i.weight < 0)) throw new Error("Weights cannot be negative.");
  for (const i of items) {
    const lo = i.scaleMin ?? 1, hi = i.scaleMax ?? 5;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      throw new Error(`"${i.name.trim()}" needs a scale whose maximum is above its minimum.`);
    }
  }
  if (items.reduce((a, b) => a + b.weight, 0) <= 0) throw new Error("At least one criterion needs a weight above zero.");

  return tx(() => {
    const next = (get<{ n: number }>(`SELECT IFNULL(MAX(version),0) AS n FROM rubric_versions WHERE event_id = ?`, cap.eventId)!.n) + 1;
    const id = newId("rub");
    run(
      `INSERT INTO rubric_versions (id, event_id, version, name, status, created_by, created_at)
       VALUES (?,?,?,?, 'draft', ?, ?)`,
      id, cap.eventId, next, name || `Rubric v${next}`, cap.actor!.id, nowIso(),
    );
    items.forEach((it, i) => {
      run(
        `INSERT INTO criteria (id, rubric_version_id, name, description, weight, scale_min, scale_max, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId("crt"), id, it.name.trim(), it.description ?? "", it.weight,
        it.scaleMin ?? 1, it.scaleMax ?? 5, i,
      );
    });
    audit.record({ actor: cap.actor, eventId: cap.eventId, action: "rubric.create", subjectType: "rubric", subjectId: id, detail: { version: next, criteria: items.length } });
    return rubricById(id)!;
  });
}

/**
 * Publishing supersedes the previous rubric but never rewrites it: reviews keep
 * pointing at the version they were scored against, so an old result stays
 * reproducible.
 */
export function publishRubric(cap: Capability, rubricId: string): RubricRow {
  requireOrganizer(cap);
  const r = rubricById(rubricId);
  if (!r || r.event_id !== cap.eventId) throw new AccessDenied("rubric belongs to another event");
  return tx(() => {
    run(`UPDATE rubric_versions SET status = 'superseded' WHERE event_id = ? AND status = 'published'`, cap.eventId);
    run(`UPDATE rubric_versions SET status = 'published', published_at = ? WHERE id = ?`, nowIso(), rubricId);
    audit.record({ actor: cap.actor, eventId: cap.eventId, action: "rubric.publish", subjectType: "rubric", subjectId: rubricId });
    return rubricById(rubricId)!;
  });
}

// -------------------------------------------------------------- assignment --

/** Deterministic pseudo-random from a seed string: same seed, same plan. */
function seededOrder<T>(items: T[], seed: string, key: (t: T) => string): T[] {
  return [...items]
    .map((it) => ({ it, h: createHash("sha256").update(seed + "|" + key(it)).digest("hex") }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .map((x) => x.it);
}

export type AssignmentPlan = {
  /** Assignments this run made, or would make when `dryRun` is set. */
  created: number;
  target: number;
  projectsConsidered: number;
  skipped: { projectId: string; projectName: string; reason: string }[];
  loads: { judgeId: string; displayName: string; count: number }[];
  /** Reviews per project after this run: the coverage the organizer is approving. */
  coverage: { projectId: string; projectName: string; reviews: number; short: number }[];
};

/**
 * Balanced round-robin assignment.
 *
 * For each submitted project, pick the N eligible judges carrying the lightest
 * load. Eligibility = holds a judge grant for the event, is allowed on the
 * project's track, and is not on the project's own team. Existing assignments
 * are preserved and counted, so the function can be run again after more
 * projects arrive without reshuffling the panel.
 */
export function generateAssignments(
  cap: Capability,
  opts: { reviewsPerProject?: number; batchLabel?: string; seed?: string; dryRun?: boolean } = {},
): AssignmentPlan {
  requireOrganizer(cap);
  const event = eventById(cap.eventId)!;
  const target = opts.reviewsPerProject ?? event.reviews_per_project;
  const seed = opts.seed ?? `${cap.eventId}:${target}`;
  const batchLabel = opts.batchLabel ?? new Date().toISOString().slice(0, 10);

  const judges = all<{ user_id: string; display_name: string; track_id: string | null }>(
    `SELECT r.user_id, u.display_name, r.track_id
       FROM event_roles r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.role = 'judge'`,
    cap.eventId,
  );
  if (judges.length === 0) throw new Error("Invite at least one judge before generating assignments.");

  // Collapse multiple grants per judge into one eligibility record.
  const judgeTracks = new Map<string, { name: string; tracks: string[] | null }>();
  for (const j of judges) {
    const cur = judgeTracks.get(j.user_id) ?? { name: j.display_name, tracks: [] as string[] | null };
    if (j.track_id === null) cur.tracks = null;
    else if (cur.tracks !== null) cur.tracks.push(j.track_id);
    judgeTracks.set(j.user_id, cur);
  }

  const projects = all<{ id: string; name: string; track_id: string | null }>(
    `SELECT id, name, track_id FROM projects
      WHERE event_id = ? AND status = 'submitted' AND disqualified_at IS NULL`, cap.eventId);

  const existingCounts = new Map<string, number>();
  const loads = new Map<string, number>();
  for (const id of judgeTracks.keys()) {
    loads.set(id, get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments WHERE event_id = ? AND judge_user_id = ? AND status != 'revoked'`,
      cap.eventId, id)!.n);
  }

  const skipped: AssignmentPlan["skipped"] = [];
  const covered = new Map<string, number>();
  let created = 0;

  // A dry run walks exactly the same path and writes nothing: the preview an
  // organizer approves is produced by the code that does the work, not by a
  // second implementation that could disagree with it.
  const write = opts.dryRun ? (fn: () => void) => { fn(); } : tx;
  write(() => {
    for (const project of seededOrder(projects, seed, (p) => p.id)) {
      const existing = all<{ judge_user_id: string }>(
        `SELECT judge_user_id FROM assignments WHERE project_id = ? AND status != 'revoked'`, project.id,
      ).map((r) => r.judge_user_id);
      existingCounts.set(project.id, existing.length);
      const need = target - existing.length;
      if (need <= 0) continue;

      const eligible = [...judgeTracks.entries()]
        .filter(([judgeId, info]) => {
          if (existing.includes(judgeId)) return false;
          if (info.tracks !== null) {
            if (project.track_id === null) return false;
            if (!info.tracks.includes(project.track_id)) return false;
          }
          return !hasConflict(judgeId, project.id);
        })
        .map(([judgeId, info]) => ({ judgeId, name: info.name }));

      if (eligible.length === 0) {
        skipped.push({ projectId: project.id, projectName: project.name, reason: "no eligible judge (track restriction or conflict of interest)" });
        continue;
      }
      if (eligible.length < need) {
        skipped.push({
          projectId: project.id, projectName: project.name,
          reason: `only ${eligible.length} eligible judge(s) for ${need} remaining review slot(s)`,
        });
      }

      const ordered = seededOrder(eligible, seed + project.id, (e) => e.judgeId)
        .sort((a, b) => (loads.get(a.judgeId) ?? 0) - (loads.get(b.judgeId) ?? 0));

      for (const pick of ordered.slice(0, Math.min(need, eligible.length))) {
        if (!opts.dryRun) {
          run(
            `INSERT OR IGNORE INTO assignments (id, event_id, project_id, judge_user_id, status, batch_label, assigned_by, assigned_at)
             VALUES (?,?,?,?, 'pending', ?, ?, ?)`,
            newId("asg"), cap.eventId, project.id, pick.judgeId, batchLabel, cap.actor?.id ?? null, nowIso(),
          );
        }
        loads.set(pick.judgeId, (loads.get(pick.judgeId) ?? 0) + 1);
        created++;
        covered.set(project.id, (covered.get(project.id) ?? existing.length) + 1);
      }
    }
    if (opts.dryRun) return;
    audit.record({
      actor: cap.actor, eventId: cap.eventId, action: "assignment.generate",
      subjectType: "event", subjectId: cap.eventId,
      detail: { created, target, batchLabel, skipped: skipped.length },
    });
    if (created > 0) webhooks.emit(cap.eventId, "assignment.created", { created, batch_label: batchLabel });
  });

  return {
    created, skipped, target, projectsConsidered: projects.length,
    loads: [...judgeTracks.entries()]
      .map(([judgeId, info]) => ({ judgeId, displayName: info.name, count: loads.get(judgeId) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName)),
    coverage: projects
      .map((p) => ({
        projectId: p.id, projectName: p.name,
        reviews: covered.get(p.id) ?? existingCounts.get(p.id) ?? 0,
      }))
      .map((c) => ({ ...c, short: Math.max(0, target - c.reviews) }))
      .sort((a, b) => b.short - a.short || a.projectName.localeCompare(b.projectName)),
  };
}

export function assignManually(cap: Capability, projectId: string, judgeUserId: string) {
  requireOrganizer(cap);
  if (hasConflict(judgeUserId, projectId)) throw new Error("That judge is on the project's own team.");
  run(
    `INSERT OR IGNORE INTO assignments (id, event_id, project_id, judge_user_id, status, batch_label, assigned_by, assigned_at)
     VALUES (?,?,?,?, 'pending', 'manual', ?, ?)`,
    newId("asg"), cap.eventId, projectId, judgeUserId, cap.actor?.id ?? null, nowIso(),
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "assignment.manual", subjectType: "project", subjectId: projectId, detail: { judgeUserId } });
}

export function revokeAssignment(cap: Capability, assignmentId: string) {
  requireOrganizer(cap);
  run(`UPDATE assignments SET status = 'revoked', revoked_at = ? WHERE id = ? AND event_id = ?`, nowIso(), assignmentId, cap.eventId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "assignment.revoke", subjectType: "assignment", subjectId: assignmentId });
}

// ------------------------------------------------------------------ queue ---

export type QueueItem = {
  assignment_id: string; project_id: string; project_name: string; tagline: string;
  track_name: string | null; status: string; review_status: string | null; submitted_at: string | null;
};

/**
 * A judge's own queue. The WHERE clause is the isolation boundary: rows are
 * selected by assignment ownership, so there is no query shape that returns a
 * peer's work even if a caller passes someone else's id.
 */
export function queueFor(cap: Capability, actor: Actor): QueueItem[] {
  requireJudge(cap);
  return all<QueueItem>(
    `SELECT a.id AS assignment_id, a.status, p.id AS project_id, p.name AS project_name,
            p.tagline, tr.name AS track_name, r.status AS review_status, p.submitted_at
       FROM assignments a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN tracks tr ON tr.id = p.track_id
       LEFT JOIN reviews r ON r.assignment_id = a.id
      WHERE a.event_id = ? AND a.judge_user_id = ? AND a.status != 'revoked'
      ORDER BY CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END, p.name`,
    cap.eventId, actor.id,
  );
}

export type ReviewView = {
  assignment: AssignmentRow;
  project: { id: string; name: string; tagline: string; description: string; track_id: string | null; repo_url: string; live_url: string; demo_video_url: string };
  rubric: RubricRow;
  criteria: CriterionRow[];
  review: { id: string; status: string; overall_comment: string; version: number } | null;
  scores: Record<string, { score: number; comment: string }>;
};

/**
 * Opens one assignment for its owner. Ownership, track eligibility and conflict
 * of interest are all re-checked here rather than trusted from the queue.
 */
export function openReview(cap: Capability, actor: Actor, assignmentId: string): ReviewView {
  requireJudge(cap);
  const a = get<AssignmentRow>(
    `SELECT * FROM assignments WHERE id = ? AND event_id = ?`, assignmentId, cap.eventId);
  if (!a) throw new AccessDenied("assignment not found in this event");
  if (a.judge_user_id !== actor.id) {
    audit.record({ actor, eventId: cap.eventId, action: "review.open", subjectType: "assignment", subjectId: assignmentId, outcome: "denied", detail: { reason: "not the assigned judge" } });
    throw new AccessDenied("this assignment belongs to another judge");
  }
  if (a.status === "revoked") throw new AccessDenied("this assignment has been revoked");

  const project = get<ReviewView["project"]>(
    `SELECT id, name, tagline, description, track_id, repo_url, live_url, demo_video_url FROM projects WHERE id = ?`, a.project_id)!;
  if (cap.judgeTrackIds !== null && (project.track_id === null || !cap.judgeTrackIds.includes(project.track_id))) {
    audit.record({ actor, eventId: cap.eventId, action: "review.open", subjectType: "assignment", subjectId: assignmentId, outcome: "denied", detail: { reason: "track restriction" } });
    throw new AccessDenied("this project is outside your track");
  }
  if (hasConflict(actor.id, a.project_id)) throw new AccessDenied("conflict of interest");

  const rubric = publishedRubric(cap.eventId);
  if (!rubric) throw new Error("The organizer has not published a rubric yet.");

  const review = get<{ id: string; status: string; overall_comment: string; version: number }>(
    `SELECT id, status, overall_comment, version FROM reviews WHERE assignment_id = ?`, assignmentId) ?? null;
  const scores: ReviewView["scores"] = {};
  if (review) {
    for (const s of all<{ criterion_id: string; score: number; comment: string }>(
      `SELECT criterion_id, score, comment FROM criterion_scores WHERE review_id = ?`, review.id)) {
      scores[s.criterion_id] = { score: s.score, comment: s.comment };
    }
  }
  return { assignment: a, project, rubric, criteria: criteria(rubric.id), review, scores };
}

export function saveReview(
  cap: Capability, actor: Actor, assignmentId: string,
  input: { scores: Record<string, number>; comments?: Record<string, string>; overall?: string; submit: boolean },
): { reviewId: string; status: string } {
  const view = openReview(cap, actor, assignmentId); // re-runs every access check
  const event = eventById(cap.eventId)!;
  if (input.submit && !judgingOpen(event) && !cap.isOrganizer) {
    throw new Error("The judging window for this event is closed.");
  }
  if (view.review?.status === "submitted" && !cap.isOrganizer) {
    throw new Error("This review has already been submitted.");
  }

  const byId = new Map(view.criteria.map((c) => [c.id, c]));
  for (const [criterionId, raw] of Object.entries(input.scores)) {
    const c = byId.get(criterionId);
    if (!c) throw new Error("Unknown criterion for this rubric.");
    if (!Number.isFinite(raw) || raw < c.scale_min || raw > c.scale_max) {
      throw new Error(`"${c.name}" must be between ${c.scale_min} and ${c.scale_max}.`);
    }
  }
  if (input.submit) {
    const missing = view.criteria.filter((c) => input.scores[c.id] === undefined);
    if (missing.length) throw new Error(`Score every criterion before submitting: ${missing.map((m) => m.name).join(", ")}.`);
  }

  return tx(() => {
    const now = nowIso();
    let reviewId = view.review?.id;
    if (!reviewId) {
      reviewId = newId("rvw");
      run(
        `INSERT INTO reviews (id, assignment_id, rubric_version_id, status, overall_comment, created_at, updated_at)
         VALUES (?,?,?, 'draft', ?, ?, ?)`,
        reviewId, assignmentId, view.rubric.id, input.overall ?? "", now, now,
      );
    }
    for (const [criterionId, score] of Object.entries(input.scores)) {
      run(
        `INSERT INTO criterion_scores (id, review_id, criterion_id, score, comment)
         VALUES (?,?,?,?,?)
         ON CONFLICT(review_id, criterion_id) DO UPDATE SET score = excluded.score, comment = excluded.comment`,
        newId("csc"), reviewId, criterionId, score, input.comments?.[criterionId] ?? "",
      );
    }

    const status = input.submit ? "submitted" : "draft";
    const entries = Object.entries(input.scores).map(([criterionId, score]) => ({ criterionId, score }));
    const weights = view.criteria.map((c) => ({
      criterionId: c.id, weight: c.weight, scaleMin: c.scale_min, scaleMax: c.scale_max,
    }));
    const weighted = input.submit ? weightedScore(entries, weights) : null;
    const weighted100 = input.submit ? weightedScore100(entries, weights) : null;
    const complete = isComplete(entries, weights) ? 1 : 0;

    run(
      `UPDATE reviews SET status = ?, overall_comment = ?, raw_weighted = ?, raw_weighted_100 = ?,
         complete = ?, updated_at = ?,
         submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END,
         version = version + 1
       WHERE id = ?`,
      status, input.overall ?? view.review?.overall_comment ?? "", weighted, weighted100,
      complete, now, status, now, reviewId,
    );
    run(`UPDATE assignments SET status = ? WHERE id = ?`, input.submit ? "submitted" : "in_progress", assignmentId);
    audit.record({
      actor, eventId: cap.eventId, action: input.submit ? "review.submit" : "review.save",
      subjectType: "project", subjectId: view.project.id, detail: { assignmentId },
    });
    if (input.submit) {
      webhooks.emit(cap.eventId, "review.submitted", {
        project_id: view.project.id, assignment_id: assignmentId,
      });
    }
    return { reviewId, status };
  });
}

// --------------------------------------------------------------- progress ---

export type JudgeProgress = {
  user_id: string; display_name: string; email: string;
  assigned: number; submitted: number; drafts: number; last_activity: string | null;
};

export function judgeProgress(cap: Capability): JudgeProgress[] {
  requireOrganizer(cap);
  return all<JudgeProgress>(
    `SELECT u.id AS user_id, u.display_name, u.email,
            COUNT(a.id) AS assigned,
            SUM(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN r.status = 'draft' THEN 1 ELSE 0 END) AS drafts,
            MAX(r.updated_at) AS last_activity
       FROM event_roles er
       JOIN users u ON u.id = er.user_id
       LEFT JOIN assignments a ON a.judge_user_id = u.id AND a.event_id = er.event_id AND a.status != 'revoked'
       LEFT JOIN reviews r ON r.assignment_id = a.id
      WHERE er.event_id = ? AND er.role = 'judge'
      GROUP BY u.id, u.display_name, u.email
      ORDER BY submitted ASC, u.display_name`,
    cap.eventId,
  );
}

/**
 * The organizer overview's numbers, in one query set. Counts only, scoped to
 * this event, so the polling the console does carries nothing private.
 */
export function progressCounts(cap: Capability) {
  requireOrganizer(cap);
  const event = eventById(cap.eventId)!;
  const n = (sql: string, ...params: unknown[]) => get<{ n: number }>(sql, ...params)!.n;
  const e = cap.eventId;
  const short = coverageGaps(cap).filter((g) => g.short > 0).length;
  return {
    teams: n(`SELECT COUNT(*) AS n FROM teams WHERE event_id = ?`, e),
    submitted: n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'submitted' AND disqualified_at IS NULL`, e),
    drafts: n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'draft'`, e),
    disqualified: n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND disqualified_at IS NOT NULL`, e),
    assigned: n(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ? AND status != 'revoked'`, e),
    reviews: n(
      `SELECT COUNT(*) AS n FROM reviews r JOIN assignments a ON a.id = r.assignment_id
        WHERE a.event_id = ? AND r.status = 'submitted'`, e),
    judges: n(`SELECT COUNT(DISTINCT user_id) AS n FROM event_roles WHERE event_id = ? AND role = 'judge'`, e),
    judgesNotStarted: judgeProgress(cap).filter((p) => p.assigned > 0 && p.submitted === 0).length,
    short,
    target: event.reviews_per_project,
    at: nowIso(),
  };
}

export function coverageGaps(cap: Capability) {
  requireOrganizer(cap);
  const event = eventById(cap.eventId)!;
  return all<{ id: string; name: string; assigned: number; submitted: number }>(
    `SELECT p.id, p.name,
            (SELECT COUNT(*) FROM assignments a WHERE a.project_id = p.id AND a.status != 'revoked') AS assigned,
            (SELECT COUNT(*) FROM assignments a JOIN reviews r ON r.assignment_id = a.id
              WHERE a.project_id = p.id AND r.status = 'submitted') AS submitted
       FROM projects p
      WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
      ORDER BY submitted ASC, assigned ASC, p.name`,
    cap.eventId,
  ).map((r) => ({ ...r, target: event.reviews_per_project, short: Math.max(0, event.reviews_per_project - r.submitted) }));
}

/** Organizer-only: every submitted review with its scores. Judges never call this. */
export function allSubmittedReviews(cap: Capability) {
  requireOrganizer(cap);
  return all<{
    review_id: string; project_id: string; project_name: string; judge_user_id: string;
    judge_name: string; raw_weighted: number; raw_weighted_100: number;
    submitted_at: string; track_id: string | null; rubric_version_id: string;
  }>(
    `SELECT r.id AS review_id, p.id AS project_id, p.name AS project_name,
            a.judge_user_id, u.display_name AS judge_name, r.raw_weighted,
            IFNULL(r.raw_weighted_100, 0) AS raw_weighted_100, r.submitted_at,
            p.track_id, r.rubric_version_id
       FROM reviews r
       JOIN assignments a ON a.id = r.assignment_id
       JOIN projects p ON p.id = a.project_id
       JOIN users u ON u.id = a.judge_user_id
      WHERE a.event_id = ? AND r.status = 'submitted' AND r.raw_weighted IS NOT NULL AND r.complete = 1
        AND p.disqualified_at IS NULL
      ORDER BY p.name, u.display_name`,
    cap.eventId,
  );
}

/** Feedback a team may read once results are out: comments without judge identity. */
export function feedbackForProject(projectId: string) {
  return all<{ overall_comment: string; submitted_at: string }>(
    `SELECT r.overall_comment, r.submitted_at
       FROM reviews r JOIN assignments a ON a.id = r.assignment_id
      WHERE a.project_id = ? AND r.status = 'submitted' AND TRIM(r.overall_comment) != ''
      ORDER BY r.submitted_at`,
    projectId,
  );
}
