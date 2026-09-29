/**
 * Scoring maths. Internal ids MATH-xx / RUBRIC-xx map to our own test plan,
 * not to any official acceptance identifier.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, weightedScore, weightedScore100, isComplete, mean, sd,
  DEFAULT_PARAMS, METHOD, METHOD_VERSION,
} from "../lib/domain/scoring.ts";
import type { RawReview, NormalizationParams } from "../lib/domain/scoring.ts";

const P = DEFAULT_PARAMS;
const near = (a: number, b: number, tol = 1e-9, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} !== ${b} within ${tol}`);

const CRITERIA = [
  { criterionId: "c1", weight: 40, scaleMin: 1, scaleMax: 5 },
  { criterionId: "c2", weight: 25, scaleMin: 1, scaleMax: 5 },
  { criterionId: "c3", weight: 20, scaleMin: 1, scaleMax: 5 },
  { criterionId: "c4", weight: 15, scaleMin: 1, scaleMax: 5 },
];
const SCORES = [
  { criterionId: "c1", score: 4 },
  { criterionId: "c2", score: 5 },
  { criterionId: "c3", score: 3 },
  { criterionId: "c4", score: 4 },
];

describe("MATH-01 weighted score", () => {
  test("the published hand-check returns exactly 4.05 and 76.25", () => {
    near(weightedScore(SCORES, CRITERIA), 4.05, 1e-12);
    near(weightedScore100(SCORES, CRITERIA), 76.25, 1e-12);
  });

  test("weights are relative, so scaling them all changes nothing", () => {
    const doubled = CRITERIA.map((c) => ({ ...c, weight: c.weight * 2 }));
    near(weightedScore(SCORES, doubled), 4.05, 1e-12);
  });

  test("criteria on different scales are comparable once mapped to 0-100", () => {
    const mixed = [
      { criterionId: "a", weight: 1, scaleMin: 1, scaleMax: 5 },   // 5/5  -> 1.0
      { criterionId: "b", weight: 1, scaleMin: 0, scaleMax: 10 },  // 5/10 -> 0.5
    ];
    const s = [{ criterionId: "a", score: 5 }, { criterionId: "b", score: 5 }];
    near(weightedScore100(s, mixed), 75, 1e-12);
  });

  test("zero-weight and unknown criteria are excluded from both sums", () => {
    const withZero = [...CRITERIA, { criterionId: "z", weight: 0, scaleMin: 1, scaleMax: 5 }];
    const withZeroScores = [...SCORES, { criterionId: "z", score: 1 }, { criterionId: "ghost", score: 5 }];
    near(weightedScore(withZeroScores, withZero), 4.05, 1e-12);
  });

  test("an incomplete review is detectable rather than scored with terms omitted", () => {
    assert.equal(isComplete(SCORES, CRITERIA), true);
    assert.equal(isComplete(SCORES.slice(0, 3), CRITERIA), false);
  });
});

describe("MATH-02 standardization", () => {
  test("population statistics match the worked example", () => {
    near(mean([2, 3, 4]), 3, 1e-12);
    near(sd([2, 3, 4]), Math.sqrt(2 / 3), 1e-12);
  });

  test("z values for [2,3,4] are -1.224744871, 0, +1.224744871", () => {
    const reviews: RawReview[] = [
      { reviewId: "r1", projectId: "p1", judgeId: "j", weighted: 2 },
      { reviewId: "r2", projectId: "p2", judgeId: "j", weighted: 3 },
      { reviewId: "r3", projectId: "p3", judgeId: "j", weighted: 4 },
    ];
    const out = normalize(reviews, P);
    const z = (id: string) => out.reviews.find((r) => r.reviewId === id)!.z as number;
    near(z("r1"), -1.224744871, 1e-9);
    near(z("r2"), 0, 1e-12);
    near(z("r3"), 1.224744871, 1e-9);
  });

  test("the method and its version are recorded on the result", () => {
    const out = normalize([
      { reviewId: "a", projectId: "p1", judgeId: "j", weighted: 2 },
      { reviewId: "b", projectId: "p2", judgeId: "j", weighted: 4 },
      { reviewId: "c", projectId: "p3", judgeId: "j", weighted: 3 },
    ], P);
    assert.equal(out.method, METHOD);
    assert.equal(out.methodVersion, METHOD_VERSION);
    assert.equal(out.mode, "standardized");
  });

  test("a harsh judge and a generous judge converge after standardization", () => {
    const reviews: RawReview[] = [
      { reviewId: "h1", projectId: "p1", judgeId: "harsh", weighted: 1 },
      { reviewId: "h2", projectId: "p2", judgeId: "harsh", weighted: 2 },
      { reviewId: "h3", projectId: "p3", judgeId: "harsh", weighted: 3 },
      { reviewId: "k1", projectId: "p1", judgeId: "kind", weighted: 3 },
      { reviewId: "k2", projectId: "p2", judgeId: "kind", weighted: 4 },
      { reviewId: "k3", projectId: "p3", judgeId: "kind", weighted: 5 },
    ];
    const out = normalize(reviews, P);
    const zOf = (j: string) => out.reviews.filter((r) => r.judgeId === j).map((r) => r.z as number);
    // Both judges ranked the projects identically, so their z sets coincide.
    zOf("harsh").forEach((z, i) => near(z, zOf("kind")[i], 1e-12));
    assert.deepEqual(out.projects.map((p) => p.projectId), ["p3", "p2", "p1"]);
  });
});

describe("MATH-03 degenerate inputs stay finite and are flagged", () => {
  test("a judge who scores everything the same is excluded, not given a fake variance", () => {
    const reviews: RawReview[] = [
      { reviewId: "f1", projectId: "p1", judgeId: "flat", weighted: 3 },
      { reviewId: "f2", projectId: "p2", judgeId: "flat", weighted: 3 },
      { reviewId: "f3", projectId: "p3", judgeId: "flat", weighted: 3 },
      { reviewId: "d1", projectId: "p1", judgeId: "disc", weighted: 1 },
      { reviewId: "d2", projectId: "p2", judgeId: "disc", weighted: 3 },
      { reviewId: "d3", projectId: "p3", judgeId: "disc", weighted: 5 },
      { reviewId: "e1", projectId: "p1", judgeId: "other", weighted: 2 },
      { reviewId: "e2", projectId: "p2", judgeId: "other", weighted: 3 },
      { reviewId: "e3", projectId: "p3", judgeId: "other", weighted: 4 },
    ];
    const out = normalize(reviews, P);
    const flat = out.judges.find((j) => j.judgeId === "flat")!;
    assert.equal(flat.rawSd, 0);
    assert.equal(flat.usable, false);
    assert.equal(flat.excludedBecause, "no_variation");
    assert.ok(out.excludedJudges.some((e) => e.judgeId === "flat" && e.reason === "no_variation"));
    // Their raw scores survive; only the standardized contribution is dropped.
    assert.equal(out.reviews.filter((r) => r.judgeId === "flat").every((r) => r.excluded && r.z === null), true);
    for (const r of out.reviews) assert.ok(r.z === null || Number.isFinite(r.z));
    assert.deepEqual(out.projects.map((p) => p.projectId), ["p3", "p2", "p1"]);
  });

  test("a judge below the review threshold is excluded as too_few_reviews", () => {
    const reviews: RawReview[] = [
      { reviewId: "s1", projectId: "p1", judgeId: "rookie", weighted: 5 },
      { reviewId: "v1", projectId: "p1", judgeId: "vet", weighted: 2 },
      { reviewId: "v2", projectId: "p2", judgeId: "vet", weighted: 3 },
      { reviewId: "v3", projectId: "p3", judgeId: "vet", weighted: 4 },
    ];
    const out = normalize(reviews, P);
    const rookie = out.judges.find((j) => j.judgeId === "rookie")!;
    assert.equal(rookie.usable, false);
    assert.equal(rookie.excludedBecause, "too_few_reviews");
  });

  test("a project with too few usable reviews is reported, not confidently ranked", () => {
    const reviews: RawReview[] = [
      { reviewId: "a1", projectId: "lonely", judgeId: "j1", weighted: 5 },
      { reviewId: "a2", projectId: "p2", judgeId: "j1", weighted: 3 },
      { reviewId: "a3", projectId: "p3", judgeId: "j1", weighted: 1 },
      { reviewId: "b2", projectId: "p2", judgeId: "j2", weighted: 4 },
      { reviewId: "b3", projectId: "p3", judgeId: "j2", weighted: 2 },
      { reviewId: "b4", projectId: "p4", judgeId: "j2", weighted: 5 },
    ];
    const out = normalize(reviews, { ...P, minUsableReviewsPerProject: 2 });
    const lonely = out.projects.find((p) => p.projectId === "lonely")!;
    assert.equal(lonely.usableReviews, 1);
    assert.equal(lonely.sufficient, false);
    assert.equal(lonely.rank, null);
    assert.equal(lonely.normalizedMean, null);
    assert.ok(out.insufficientProjects.includes("lonely"));
    // It still has a raw score and a raw rank; it is simply not ranked on
    // comparable evidence.
    assert.ok(lonely.rawMean > 0);
    assert.ok(lonely.rawRank > 0);
  });

  test("when no judge can be standardized, the fallback is labelled not silent", () => {
    const reviews: RawReview[] = [
      { reviewId: "x1", projectId: "p1", judgeId: "a", weighted: 4 },
      { reviewId: "x2", projectId: "p2", judgeId: "a", weighted: 4 },
      { reviewId: "x3", projectId: "p3", judgeId: "a", weighted: 4 },
      { reviewId: "y1", projectId: "p1", judgeId: "b", weighted: 2 },
      { reviewId: "y2", projectId: "p2", judgeId: "b", weighted: 2 },
      { reviewId: "y3", projectId: "p3", judgeId: "b", weighted: 2 },
    ];
    const out = normalize(reviews, P);
    assert.equal(out.mode, "raw_fallback");
    assert.equal(out.excludedJudges.length, 2);
    assert.ok(out.projects.every((p) => p.sufficient === false));
    assert.ok(out.projects.every((p) => Number.isFinite(p.normalizedMean as number)));
  });

  test("an empty cohort does not throw", () => {
    const out = normalize([], P);
    assert.equal(out.projects.length, 0);
    assert.equal(out.reviews.length, 0);
    assert.equal(mean([]), 0);
    assert.equal(sd([]), 0);
  });
});

describe("MATH-05 determinism", () => {
  const reviews: RawReview[] = [
    { reviewId: "r1", projectId: "p1", judgeId: "j1", weighted: 4 },
    { reviewId: "r2", projectId: "p2", judgeId: "j1", weighted: 2 },
    { reviewId: "r3", projectId: "p3", judgeId: "j1", weighted: 3 },
    { reviewId: "r4", projectId: "p1", judgeId: "j2", weighted: 3 },
    { reviewId: "r5", projectId: "p2", judgeId: "j2", weighted: 5 },
    { reviewId: "r6", projectId: "p3", judgeId: "j2", weighted: 4 },
  ];

  test("permuting the input does not change the ranking", () => {
    const a = normalize(reviews, P).projects.map((p) => `${p.projectId}:${p.rank}`);
    const b = normalize([...reviews].reverse(), P).projects.map((p) => `${p.projectId}:${p.rank}`);
    const c = normalize([reviews[3], reviews[0], reviews[5], reviews[1], reviews[4], reviews[2]], P)
      .projects.map((p) => `${p.projectId}:${p.rank}`);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  test("reruns produce identical numbers", () => {
    const a = normalize(reviews, P);
    const b = normalize(reviews, P);
    assert.deepEqual(
      a.projects.map((p) => [p.projectId, p.meanZ, p.rank]),
      b.projects.map((p) => [p.projectId, p.meanZ, p.rank]),
    );
  });

  test("ranks are a dense 1..n sequence over rankable projects", () => {
    const out = normalize(reviews, P);
    const ranks = out.projects.filter((p) => p.rank !== null).map((p) => p.rank as number);
    assert.deepEqual([...ranks].sort((x, y) => x - y), ranks.map((_, i) => i + 1));
  });
});

describe("MATH-06 amendment recomputes the cohort", () => {
  test("changing one review moves other projects too, because judge stats change", () => {
    const base: RawReview[] = [
      { reviewId: "r1", projectId: "p1", judgeId: "j1", weighted: 4 },
      { reviewId: "r2", projectId: "p2", judgeId: "j1", weighted: 3 },
      { reviewId: "r3", projectId: "p3", judgeId: "j1", weighted: 2 },
      { reviewId: "r4", projectId: "p1", judgeId: "j2", weighted: 3 },
      { reviewId: "r5", projectId: "p2", judgeId: "j2", weighted: 4 },
      { reviewId: "r6", projectId: "p3", judgeId: "j2", weighted: 5 },
    ];
    const before = normalize(base, P);
    const amended = base.map((r) => (r.reviewId === "r1" ? { ...r, weighted: 1 } : r));
    const after = normalize(amended, P);
    const j1before = before.judges.find((j) => j.judgeId === "j1")!;
    const j1after = after.judges.find((j) => j.judgeId === "j1")!;
    assert.notEqual(j1before.rawMean, j1after.rawMean);
    // p2 was untouched, but its standardized value moves because j1's centre did.
    const p2before = before.projects.find((p) => p.projectId === "p2")!.meanZ;
    const p2after = after.projects.find((p) => p.projectId === "p2")!.meanZ;
    assert.notEqual(p2before, p2after);
  });
});

describe("MATH-07 ties and coverage policy", () => {
  test("a genuine tie is broken deterministically and never by float jitter", () => {
    const reviews: RawReview[] = [
      { reviewId: "a1", projectId: "bbb", judgeId: "j1", weighted: 4 },
      { reviewId: "a2", projectId: "aaa", judgeId: "j1", weighted: 4 },
      { reviewId: "a3", projectId: "ccc", judgeId: "j1", weighted: 2 },
      { reviewId: "b1", projectId: "bbb", judgeId: "j2", weighted: 4 },
      { reviewId: "b2", projectId: "aaa", judgeId: "j2", weighted: 4 },
      { reviewId: "b3", projectId: "ccc", judgeId: "j2", weighted: 2 },
    ];
    const out = normalize(reviews, P);
    const aaa = out.projects.find((p) => p.projectId === "aaa")!;
    const bbb = out.projects.find((p) => p.projectId === "bbb")!;
    near(aaa.meanZ as number, bbb.meanZ as number, 1e-12);
    // Tied on score, so the stable secondary order is by id, not by insertion.
    assert.ok((aaa.rank as number) < (bbb.rank as number));
  });

  test("usable review count is reported separately from completed count", () => {
    const reviews: RawReview[] = [
      { reviewId: "f1", projectId: "p1", judgeId: "flat", weighted: 3 },
      { reviewId: "f2", projectId: "p2", judgeId: "flat", weighted: 3 },
      { reviewId: "f3", projectId: "p3", judgeId: "flat", weighted: 3 },
      { reviewId: "d1", projectId: "p1", judgeId: "d1", weighted: 1 },
      { reviewId: "d2", projectId: "p2", judgeId: "d1", weighted: 3 },
      { reviewId: "d3", projectId: "p3", judgeId: "d1", weighted: 5 },
      { reviewId: "e1", projectId: "p1", judgeId: "d2", weighted: 2 },
      { reviewId: "e2", projectId: "p2", judgeId: "d2", weighted: 3 },
      { reviewId: "e3", projectId: "p3", judgeId: "d2", weighted: 4 },
    ];
    const out = normalize(reviews, P);
    const p1 = out.projects.find((p) => p.projectId === "p1")!;
    assert.equal(p1.reviewsCounted, 3);
    assert.equal(p1.usableReviews, 2);   // the flat judge's review does not count
  });
});
