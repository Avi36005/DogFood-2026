import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, requireOrganizer, type Capability } from "../authz.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";
import { byId as eventById } from "./events.ts";
import { allSubmittedReviews } from "./judging.ts";
import {
  normalize, DEFAULT_PARAMS, METHOD, METHOD_VERSION,
  type NormalizationParams, type NormalizationResult,
} from "./scoring.ts";
import { publishedRubric } from "./judging.ts";

export type SnapshotRow = {
  id: string; event_id: string; algorithm: string; params_json: string;
  status: string; method: string; method_version: string; mode: string;
  rubric_version_id: string | null; warnings_json: string;
  computed_by: string; computed_at: string; published_at: string | null;
};

export type ResultRow = {
  id: string; snapshot_id: string; project_id: string; track_id: string | null;
  rank: number | null; rank_in_track: number | null;
  raw_mean: number | null; raw_mean_100: number | null; mean_z: number | null;
  normalized_mean: number | null;
  reviews_counted: number; usable_reviews: number; sufficient: number;
  raw_rank: number | null; rank_delta: number | null;
  project_name?: string; team_name?: string; track_name?: string | null;
};

/**
 * Runs the normalization over every complete, submitted review in the cohort
 * and stores an immutable snapshot. Nothing becomes public here.
 */
export function computeSnapshot(cap: Capability, params: NormalizationParams = DEFAULT_PARAMS): SnapshotRow {
  requireOrganizer(cap);
  const reviews = allSubmittedReviews(cap);
  if (reviews.length === 0) throw new Error("No submitted reviews to score yet.");

  // Cohort identity: one event, one rubric version. Mixing rubric versions
  // would standardise scores that do not mean the same thing.
  const rubric = publishedRubric(cap.eventId);
  const cohort = rubric ? reviews.filter((r) => r.rubric_version_id === rubric.id) : reviews;
  if (cohort.length === 0) {
    throw new Error("No submitted reviews against the published rubric version.");
  }

  const result: NormalizationResult = normalize(
    cohort.map((r) => ({
      reviewId: r.review_id, projectId: r.project_id,
      judgeId: r.judge_user_id, weighted: r.raw_weighted, weighted100: r.raw_weighted_100,
    })),
    params,
  );

  const trackOf = new Map(cohort.map((r) => [r.project_id, r.track_id]));

  const warnings: string[] = [];
  if (result.mode === "raw_fallback") {
    warnings.push("No judge could be standardized. Showing raw scores, labelled as a fallback.");
  }
  for (const e of result.excludedJudges) {
    const name = cohort.find((r) => r.judge_user_id === e.judgeId)?.judge_name ?? e.judgeId;
    warnings.push(
      e.reason === "no_variation"
        ? `${name} gave the same score to every project (${e.n} reviews); excluded from standardization, raw scores kept.`
        : `${name} has only ${e.n} review(s), below the threshold for estimating their spread; excluded from standardization.`,
    );
  }
  if (result.insufficientProjects.length) {
    warnings.push(`${result.insufficientProjects.length} project(s) lack enough comparable reviews to rank.`);
  }

  return tx(() => {
    const id = newId("snp");
    run(
      `INSERT INTO result_snapshots
         (id, event_id, algorithm, params_json, status, method, method_version, mode,
          rubric_version_id, warnings_json, computed_by, computed_at)
       VALUES (?,?,?,?, 'computed', ?,?,?,?,?,?,?)`,
      id, cap.eventId, "within_judge_population_z",
      JSON.stringify({ ...params, globalMean: result.globalMean, globalSd: result.globalSd }),
      METHOD, METHOD_VERSION, result.mode, rubric?.id ?? null,
      JSON.stringify(warnings), cap.actor!.id, nowIso(),
    );

    // Per-track placings come from the same ordering, never re-scored.
    const seenInTrack = new Map<string, number>();
    for (const p of result.projects) {
      const trackId = trackOf.get(p.projectId) ?? null;
      let rankInTrack: number | null = null;
      if (p.rank !== null) {
        const key = trackId ?? "__none__";
        rankInTrack = (seenInTrack.get(key) ?? 0) + 1;
        seenInTrack.set(key, rankInTrack);
      }
      run(
        `INSERT INTO result_rows (id, snapshot_id, project_id, track_id, rank, rank_in_track,
            raw_mean, raw_mean_100, mean_z, normalized_mean,
            reviews_counted, usable_reviews, sufficient, raw_rank, rank_delta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("rrw"), id, p.projectId, trackId, p.rank, rankInTrack,
        p.rawMean, p.rawMean100, p.meanZ, p.normalizedMean,
        p.reviewsCounted, p.usableReviews, p.sufficient ? 1 : 0, p.rawRank, p.rankDelta,
      );
    }
    audit.record({
      actor: cap.actor, eventId: cap.eventId, action: "results.compute",
      subjectType: "snapshot", subjectId: id,
      detail: {
        projects: result.projects.length, reviews: cohort.length, mode: result.mode,
        excludedJudges: result.excludedJudges.length,
        insufficientProjects: result.insufficientProjects.length,
      },
    });
    return get<SnapshotRow>(`SELECT * FROM result_snapshots WHERE id = ?`, id)!;
  });
}

export function latestSnapshot(eventId: string, status?: string): SnapshotRow | undefined {
  return status
    ? get<SnapshotRow>(`SELECT * FROM result_snapshots WHERE event_id = ? AND status = ? ORDER BY computed_at DESC LIMIT 1`, eventId, status)
    : get<SnapshotRow>(`SELECT * FROM result_snapshots WHERE event_id = ? ORDER BY computed_at DESC LIMIT 1`, eventId);
}

export function snapshots(cap: Capability): SnapshotRow[] {
  requireOrganizer(cap);
  return all<SnapshotRow>(`SELECT * FROM result_snapshots WHERE event_id = ? ORDER BY computed_at DESC`, cap.eventId);
}

export function rows(snapshotId: string): ResultRow[] {
  return all<ResultRow>(
    `SELECT rr.*, p.name AS project_name, t.name AS team_name, tr.name AS track_name
       FROM result_rows rr
       JOIN projects p ON p.id = rr.project_id
       JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = rr.track_id
      WHERE rr.snapshot_id = ?
      ORDER BY rr.rank IS NULL, rr.rank, rr.raw_rank`,
    snapshotId,
  );
}

export function publish(cap: Capability, snapshotId: string): SnapshotRow {
  requireOrganizer(cap);
  const snap = get<SnapshotRow>(`SELECT * FROM result_snapshots WHERE id = ? AND event_id = ?`, snapshotId, cap.eventId);
  if (!snap) throw new AccessDenied("snapshot belongs to another event");
  return tx(() => {
    run(`UPDATE result_snapshots SET status = 'superseded' WHERE event_id = ? AND status = 'published'`, cap.eventId);
    run(`UPDATE result_snapshots SET status = 'published', published_at = ? WHERE id = ?`, nowIso(), snapshotId);
    run(`UPDATE events SET status = 'results_published', results_published_at = ?, version = version + 1 WHERE id = ?`, nowIso(), cap.eventId);
    audit.record({ actor: cap.actor, eventId: cap.eventId, action: "results.publish", subjectType: "snapshot", subjectId: snapshotId });
    webhooks.emit(cap.eventId, "results.published", { snapshot_id: snapshotId });
    return get<SnapshotRow>(`SELECT * FROM result_snapshots WHERE id = ?`, snapshotId)!;
  });
}

export function unpublish(cap: Capability, snapshotId: string) {
  requireOrganizer(cap);
  run(`UPDATE result_snapshots SET status = 'computed', published_at = NULL WHERE id = ? AND event_id = ?`, snapshotId, cap.eventId);
  run(`UPDATE events SET status = 'judging', results_published_at = NULL, version = version + 1 WHERE id = ?`, cap.eventId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "results.unpublish", subjectType: "snapshot", subjectId: snapshotId });
}

/** Public results: only ever the published snapshot of a published event. */
export function publicResults(eventId: string): { snapshot: SnapshotRow; rows: ResultRow[] } | null {
  const event = eventById(eventId);
  if (!event || event.status !== "results_published") return null;
  const snap = latestSnapshot(eventId, "published");
  if (!snap) return null;
  return { snapshot: snap, rows: rows(snap.id) };
}

/** The normalization evidence an organizer can show: raw vs normalized, judge by judge. */
export function normalizationReport(cap: Capability, params: NormalizationParams = DEFAULT_PARAMS) {
  requireOrganizer(cap);
  const reviews = allSubmittedReviews(cap);
  if (reviews.length === 0) return null;
  const nameById = new Map(reviews.map((r) => [r.judge_user_id, r.judge_name]));
  const projectNameById = new Map(reviews.map((r) => [r.project_id, r.project_name]));
  const rubric = publishedRubric(cap.eventId);
  const cohort = rubric ? reviews.filter((r) => r.rubric_version_id === rubric.id) : reviews;
  if (cohort.length === 0) return null;
  const result = normalize(
    cohort.map((r) => ({
      reviewId: r.review_id, projectId: r.project_id, judgeId: r.judge_user_id,
      weighted: r.raw_weighted, weighted100: r.raw_weighted_100,
    })),
    params,
  );
  return {
    ...result,
    judges: result.judges.map((j) => ({ ...j, displayName: nameById.get(j.judgeId) ?? j.judgeId })),
    projects: result.projects.map((p) => ({ ...p, projectName: projectNameById.get(p.projectId) ?? p.projectId })),
  };
}
