/**
 * Weighted scoring and cross-judge normalization.
 *
 * Pure functions, no database access, so the maths is testable directly and an
 * organizer can reproduce a published ranking from exported CSV. The method,
 * its assumptions and its failure modes are written up in JUDGING.md.
 */

export type CriterionWeight = {
  criterionId: string;
  weight: number;
  scaleMin: number;
  scaleMax: number;
};

export type RawReview = {
  reviewId: string;
  projectId: string;
  judgeId: string;
  /** Weighted mean on the rubric scale. */
  weighted: number;
  /** Same review mapped linearly to 0-100, for display and export. */
  weighted100?: number;
};

export type NormalizationParams = {
  /**
   * Minimum completed reviews before a judge's own spread is trusted enough to
   * standardise against. Below this the judge is excluded and flagged, rather
   * than being given an invented variance.
   */
  minReviewsForVariance: number;
  /** Spread at or below this counts as "no variation at all". */
  minSigma: number;
  /** Usable (non-excluded) reviews a project needs before it gets a rank. */
  minUsableReviewsPerProject: number;
  scaleMin: number;
  scaleMax: number;
};

export const DEFAULT_PARAMS: NormalizationParams = {
  minReviewsForVariance: 3,
  minSigma: 1e-9,
  minUsableReviewsPerProject: 2,
  scaleMin: 1,
  scaleMax: 5,
};

export type ExclusionReason = "too_few_reviews" | "no_variation";

export type JudgeStats = {
  judgeId: string;
  n: number;
  rawMean: number;
  rawSd: number;
  /** Whether this judge's reviews were standardised. */
  usable: boolean;
  excludedBecause: ExclusionReason | null;
  /** Distance from the panel centre in panel standard deviations. */
  biasInSigma: number;
};

export type NormalizedReview = RawReview & {
  z: number | null;
  /** Standardised score mapped back onto the rubric scale, for display. */
  normalized: number | null;
  excluded: boolean;
};

export type ProjectScore = {
  projectId: string;
  /** Completed reviews, including those from excluded judges. */
  reviewsCounted: number;
  /** Reviews that actually contributed to the normalized figure. */
  usableReviews: number;
  rawMean: number;
  rawMean100: number;
  meanZ: number | null;
  normalizedMean: number | null;
  /** False when there were too few usable reviews to rank honestly. */
  sufficient: boolean;
  rank: number | null;
  rawRank: number;
  rankDelta: number | null;
};

export type NormalizationMode = "standardized" | "raw_fallback";

export type NormalizationResult = {
  method: string;
  methodVersion: string;
  mode: NormalizationMode;
  globalMean: number;
  globalSd: number;
  judges: JudgeStats[];
  reviews: NormalizedReview[];
  projects: ProjectScore[];
  params: NormalizationParams;
  /** Judges excluded from standardisation, surfaced for the organizer. */
  excludedJudges: { judgeId: string; reason: ExclusionReason; n: number }[];
  /** Projects that could not be ranked on comparable evidence. */
  insufficientProjects: string[];
  computedAt: string;
};

export const METHOD = "within-judge population standardization";
export const METHOD_VERSION = "1.0.0";

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Population standard deviation. We observe the whole of a judge's output for
 * this cohort, not a sample of it, so dividing by n is the correct convention.
 * It is stated here because the sample/population choice changes every z.
 */
export function sd(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Weighted mean of criterion scores, on the criteria's own scale.
 *
 * Hand-check: scores [4,5,3,4] with weights [40,25,20,15] on a 1-5 scale give
 * (160+125+60+60)/100 = 4.05.
 */
export function weightedScore(
  scores: { criterionId: string; score: number }[],
  criteria: CriterionWeight[],
): number {
  const byId = new Map(criteria.map((c) => [c.criterionId, c]));
  let num = 0, den = 0;
  for (const s of scores) {
    const c = byId.get(s.criterionId);
    if (!c || c.weight <= 0) continue;
    num += c.weight * s.score;
    den += c.weight;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The same review mapped to 0-100 using each criterion's own endpoints, so
 * criteria with different scales stay comparable.
 *
 * Hand-check: the example above maps to 100*(30+25+10+11.25)/100 = 76.25.
 */
export function weightedScore100(
  scores: { criterionId: string; score: number }[],
  criteria: CriterionWeight[],
): number {
  const byId = new Map(criteria.map((c) => [c.criterionId, c]));
  let num = 0, den = 0;
  for (const s of scores) {
    const c = byId.get(s.criterionId);
    if (!c || c.weight <= 0) continue;
    const span = c.scaleMax - c.scaleMin;
    if (span <= 0) continue;
    num += c.weight * ((s.score - c.scaleMin) / span);
    den += c.weight;
  }
  return den > 0 ? (100 * num) / den : 0;
}

/** True when every criterion in the rubric carries a score. */
export function isComplete(
  scores: { criterionId: string }[],
  criteria: CriterionWeight[],
): boolean {
  const scored = new Set(scores.map((s) => s.criterionId));
  return criteria.every((c) => scored.has(c.criterionId));
}

/**
 * Within-judge population standardization.
 *
 *   z = (raw - mean_j) / sd_j      over one comparable cohort
 *
 * A judge is standardised only when they have filed at least
 * `minReviewsForVariance` completed reviews AND their spread is above
 * `minSigma`. Judges who fail either test are EXCLUDED and flagged: their raw
 * scores are preserved and visible, but they contribute nothing to the
 * standardized figure. No variance is invented for them.
 *
 * Callers must pass reviews from ONE comparable cohort (one event, one rubric
 * version). Mixing rubrics would compare scores that do not mean the same thing.
 */
export function normalize(
  rawReviews: RawReview[],
  params: NormalizationParams = DEFAULT_PARAMS,
): NormalizationResult {
  const { minReviewsForVariance, minSigma, minUsableReviewsPerProject, scaleMin, scaleMax } = params;
  const computedAt = new Date().toISOString();

  const values = rawReviews.map((r) => r.weighted);
  const globalMean = mean(values);
  const globalSd = sd(values);

  const byJudge = new Map<string, RawReview[]>();
  for (const r of rawReviews) {
    const list = byJudge.get(r.judgeId) ?? [];
    list.push(r);
    byJudge.set(r.judgeId, list);
  }

  const judges: JudgeStats[] = [];
  const statsById = new Map<string, JudgeStats>();
  for (const [judgeId, list] of byJudge) {
    const xs = list.map((r) => r.weighted);
    const n = xs.length;
    const m = mean(xs);
    const s = sd(xs);
    const excludedBecause: ExclusionReason | null =
      n < minReviewsForVariance ? "too_few_reviews"
      : s <= minSigma ? "no_variation"
      : null;
    const stat: JudgeStats = {
      judgeId, n, rawMean: m, rawSd: s,
      usable: excludedBecause === null,
      excludedBecause,
      biasInSigma: globalSd > minSigma ? (m - globalMean) / globalSd : 0,
    };
    judges.push(stat);
    statsById.set(judgeId, stat);
  }
  judges.sort((a, b) => a.judgeId.localeCompare(b.judgeId));

  const usableJudges = judges.filter((j) => j.usable);
  // Nobody can be standardised: say so and fall back to raw, labelled.
  // Silently switching methods would be worse than reporting the situation.
  const mode: NormalizationMode = usableJudges.length === 0 ? "raw_fallback" : "standardized";

  const reviews: NormalizedReview[] = rawReviews.map((r) => {
    const st = statsById.get(r.judgeId)!;
    if (mode === "raw_fallback") {
      return { ...r, z: null, normalized: r.weighted, excluded: false };
    }
    if (!st.usable) return { ...r, z: null, normalized: null, excluded: true };
    const z = (r.weighted - st.rawMean) / st.rawSd;
    const display = globalSd > minSigma
      ? clamp(globalMean + z * globalSd, scaleMin, scaleMax)
      : globalMean;
    return { ...r, z, normalized: display, excluded: false };
  });

  const byProject = new Map<string, NormalizedReview[]>();
  for (const r of reviews) {
    const list = byProject.get(r.projectId) ?? [];
    list.push(r);
    byProject.set(r.projectId, list);
  }

  type Partial_ = Omit<ProjectScore, "rank" | "rawRank" | "rankDelta">;
  const partial: Partial_[] = [...byProject.entries()].map(([projectId, list]) => {
    const usable = list.filter((r) => !r.excluded && r.z !== null);
    const rawMean = mean(list.map((r) => r.weighted));
    const rawMean100 = mean(list.map((r) => r.weighted100 ?? 0));
    if (mode === "raw_fallback") {
      return {
        projectId, reviewsCounted: list.length, usableReviews: 0,
        rawMean, rawMean100, meanZ: null, normalizedMean: rawMean, sufficient: false,
      };
    }
    const sufficient = usable.length >= minUsableReviewsPerProject;
    const meanZ = usable.length ? mean(usable.map((r) => r.z as number)) : null;
    return {
      projectId,
      reviewsCounted: list.length,
      usableReviews: usable.length,
      rawMean, rawMean100,
      meanZ: sufficient ? meanZ : null,
      normalizedMean: sufficient && meanZ !== null
        ? clamp(globalMean + meanZ * globalSd, scaleMin, scaleMax)
        : null,
      sufficient,
    };
  });

  // Raw ranking covers everything; normalized ranking covers only projects with
  // enough comparable evidence. Both orders are total and deterministic.
  const rawRankById = new Map(
    [...partial]
      .sort((a, b) => b.rawMean - a.rawMean || a.projectId.localeCompare(b.projectId))
      .map((p, i) => [p.projectId, i + 1]),
  );

  const rankable = partial.filter((p) => p.sufficient && p.meanZ !== null);
  const normRankById = new Map(
    [...rankable]
      .sort((a, b) =>
        (b.meanZ as number) - (a.meanZ as number)
        || b.rawMean - a.rawMean
        || a.projectId.localeCompare(b.projectId))
      .map((p, i) => [p.projectId, i + 1]),
  );

  const projects: ProjectScore[] = partial
    .map((p) => {
      const rank = normRankById.get(p.projectId) ?? null;
      const rawRank = rawRankById.get(p.projectId)!;
      return { ...p, rank, rawRank, rankDelta: rank === null ? null : rawRank - rank };
    })
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;          // ranked projects first
      if (b.rank !== null) return 1;
      return a.rawRank - b.rawRank;            // then unrankable, by raw
    });

  return {
    method: METHOD,
    methodVersion: METHOD_VERSION,
    mode,
    globalMean,
    globalSd,
    judges,
    reviews,
    projects,
    params,
    excludedJudges: judges
      .filter((j) => !j.usable)
      .map((j) => ({ judgeId: j.judgeId, reason: j.excludedBecause!, n: j.n })),
    insufficientProjects: projects.filter((p) => !p.sufficient).map((p) => p.projectId),
    computedAt,
  };
}
