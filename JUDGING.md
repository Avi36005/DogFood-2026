# Judging

How work gets to judges, how it is scored, and what is done about the fact that
judges are not interchangeable.

---

## 1. Assignment

### Eligibility

A judge may be assigned a project only if all four hold:

1. They hold a `judge` grant for the event. Grants come from an invitation
   whose track scope is stored on the invitation row, so accepting a link
   cannot widen what it grants.
2. The project's track is inside their grant. A grant with `track_id IS NULL`
   covers every track; a grant naming a track covers that track only.
3. They are **not, and have never been, a member of the project's own team**.
   Current membership and `team_member_history` are both consulted, so leaving
   a team after assignment does not clear the conflict. Checked when assignments
   are generated *and* again every time a review is opened.
4. The project is still eligible: submitted, not withdrawn, and not
   disqualified by an organizer decision.

### Eligibility decisions

An organizer can disqualify an entry, with a reason that is recorded. The
submission itself is never rewritten — disqualification is a decision *about*
the work, not an edit *of* it. A disqualified project leaves the gallery, the
assignment pool, the ballot and the score calculation at once, because every
one of those queries filters on the same condition. Reinstating appends a second
decision; both stay on the record, and results must be recomputed to take the
project back in.

### Previewing a batch

`generateAssignments()` takes a `dryRun` flag. The organizer console runs the
planner with it set, shows the resulting workload per judge, the coverage each
project would reach, and every project that cannot be filled with the reason,
and writes nothing. Committing runs the same function again on the server: what
comes back from the browser is a decision to proceed, never the plan itself. A
dry run leaves no audit entry; a commit does.

### The algorithm

Balanced round-robin, in `generateAssignments()`:

1. Order the submitted projects deterministically. The order is a SHA-256 of
   `seed | projectId`, so it is stable and reproducible rather than
   insertion-ordered — the first team to submit should not get a systematically
   different panel from the last.
2. For each project, count existing non-revoked assignments and compute how
   many more are needed to reach the target.
3. Build the eligible judge set, then sort by **current load ascending**,
   tie-broken by the same seeded hash.
4. Take the lightest-loaded eligible judges, insert, and increment their load.

Properties worth stating plainly:

- **Idempotent-ish and additive.** Existing assignments are counted, never
  destroyed. Running it again after a late batch of submissions tops up the
  gaps rather than reshuffling a panel that has already started work.
- **Load-balanced.** Because selection is always by lightest load, the spread
  across judges stays within one or two reviews unless track restrictions force
  otherwise.
- **Disjoint per project.** A unique index on `(project_id, judge_user_id)`
  means the same judge cannot be assigned the same project twice, even under a
  concurrent generate.
- **Honest about failure.** When a project cannot be fully covered — too few
  eligible judges, a narrow track, conflicts — it is not silently skipped. The
  function returns a `skipped[]` list with the reason, the organizer sees it in
  the response, and the coverage table shows how short each project is.

### What it does not do

It does not balance by *topic expertise*, because Forgeboard has no model of
expertise beyond tracks. It does not attempt a global optimum; it is greedy. On
a 40-project, 21-judge event the greedy result is within a review of optimal,
and the simplicity is worth more than the last fraction.

---

## 2. Scoring one review

The organizer defines a rubric: named criteria, each with a **weight** and an
integer scale (default 1–5). Weights are relative, not percentages — `40/25/20/15`
and `8/5/4/3` behave identically.

A review's raw score is the weighted mean over the criteria actually scored:

```
raw  =  Σ(wᵢ · sᵢ) / Σ(wᵢ)
```

It is computed at submit time and cached on `reviews.raw_weighted`, so a later
rubric edit cannot retroactively change a score somebody already gave. Criteria
with zero weight are excluded from both sums rather than dragging the mean
toward zero.

A review cannot be submitted with a criterion left blank. Drafts may be partial.

---

## 3. Normalization

### The problem

Raw scores are not comparable across judges. Measured from the seeded 40-project event
(the seed is deterministic, so `npm run db:reset && npm run db:seed` reproduces these exactly):

| Judge | Reviews | Raw mean | Spread | Bias vs panel |
|---|---:|---:|---:|---:|
| Mo Nakamura | 5 | 2.06 | 0.90 | **−1.03σ** |
| Lena Batista | 5 | 2.55 | 0.95 | −0.56σ |
| *(panel)* | — | *3.12* | *1.03* | *0* |
| Yuki Costa | 5 | 3.91 | 1.01 | +0.76σ |
| Jai Batista | 4 | 4.31 | 0.22 | **+1.15σ** |

A project drawing Mo and a project drawing Jai are not measured with the same instrument. Averaging
raw scores lets the panel lottery decide part of the ranking.

### The method

**Within-judge population standardization**, over one comparable cohort.

```
cohort  = one event, one published rubric version
z_jp    = (raw_jp − mean_j) / sd_j        sd_j is POPULATION sd
score_p = mean of z over that project's usable reviews
display = clamp(panel_mean + score_p · panel_sd, scale_min, scale_max)
```

The variance convention is **population**, stated once here because sample-vs-population changes every
z. We observe the whole of a judge's output for the cohort, not a sample of it.

Method and version (`within-judge population standardization`, `1.0.0`), the parameters, the mode and
the coverage warnings are all stored on each snapshot, so a published ranking records how it was made.

### Who is excluded, and why exclusion rather than repair

A judge is standardized only if **both** hold:

- at least **3** completed reviews (`minReviewsForVariance`), and
- spread strictly above zero (`minSigma`).

A judge failing either is **excluded from the standardized calculation and flagged**. Their raw scores
are preserved and displayed; only their standardized contribution is dropped.

This is deliberate. The alternative — inventing a variance for a judge who has shown none, whether by
substituting the panel's or by shrinking toward it — manufactures separation from a ballot that
contains no information about relative quality. A judge who gives every project a 3 has told us
nothing about which project is better, and the honest response is to say so rather than to synthesise
an opinion on their behalf.

On the seeded data both rules fire, once each:

```
EXCLUDED  Mo Batista  n=5  sd=0.00  reason=no_variation
EXCLUDED  Umi Costa   n=2  sd=1.18  reason=too_few_reviews
```

Exclusion costs coverage, so coverage is reported: every project shows **usable / completed** reviews,
and a project with fewer than `minUsableReviewsPerProject` (default 2) usable reviews is listed as
**"insufficient comparable reviews"** with no rank at all, rather than given a confident position.

### Edge cases and what actually happens

| Case | Behaviour |
|---|---|
| Judge scores everything the same | `sd = 0` → excluded as `no_variation`, flagged, raw scores kept. No division by zero. *Tested.* |
| Judge with 1–2 reviews | Excluded as `too_few_reviews`: two numbers do not establish a judge's spread. *Tested.* |
| Project with too few usable reviews | No rank, no normalized score, listed in `insufficientProjects`. *Tested.* |
| Project with no reviews at all | Absent from the ranking; appears as a coverage gap for the organizer. |
| **Every** judge excluded | `mode: "raw_fallback"`. Raw scores are returned, explicitly labelled as a fallback in the API, the console and the snapshot. The method is never switched silently. *Tested.* |
| Extreme z | Clamped to the rubric scale for display; the ranking uses the unclamped mean z. |
| Rubric changed mid-event | Reviews keep `rubric_version_id`; the cohort is filtered to the published version, so scores against different rubrics are never mixed. |
| Incomplete review | Excluded at source: only `complete = 1` submitted reviews enter the cohort. |
| Amended review | Recomputes the **whole cohort**, because changing one review moves its judge's mean and therefore every project that judge touched. *Tested.* |
| Ties | Broken by raw mean, then project id. Deterministic and stable, and explicitly not a merit ordering. |

### Effect on the seeded data

Reproducible from the deterministic seed:

- Panel mean **3.124**, spread **1.030**, mode `standardized`
- 20 judges in the cohort, **2 excluded** (one for no variation, one for too few reviews),
  0 projects short of comparable evidence
- **32 of 36** ranked projects changed position
- *Windlass* is first on both rankings; *Notary* rises from raw #11 to normalized #4
- *Trellis* falls from raw #3 to #5 — it drew a generous panel
- Largest move: *Vantage*, raw #6 → normalized #17 (**−11**)

The organizer console shows all of this: every judge's bias and spread, whether they were included,
the raw rank, the normalized rank and the movement. The adjustment is inspectable, not asserted.

### Reproducing it independently

`normalize()` in `lib/domain/scoring.ts` is pure and takes no database. Export `reviews.csv` and
`criterion-scores.csv` and you can recompute a published ranking yourself. The worked examples in
`tests/scoring.test.ts` pin the arithmetic: weights `[40,25,20,15]` on scores `[4,5,3,4]` give exactly
**4.05/5** and **76.25/100**, and `[2,3,4]` standardizes to **[−1.224744871, 0, +1.224744871]**.

### What this method assumes, and where it breaks

- **Judges see a roughly comparable slice.** Assignment is load-balanced and seeded, which makes this
  approximately true. If an organizer hand-assigns all the strong projects to one judge, that judge's
  high mean is read as generosity and corrected away. No within-judge method survives adversarial
  assignment without a shared reference set.
- **Tracks are not separately calibrated.** One rubric spans the event, so the cohort is the event. If
  an event ran genuinely incomparable per-track rubrics, this method should not be applied across them
  — and it is not, because the cohort filter is the published rubric version.
- **Disconnected judging groups.** If no judge's set overlaps another's, standardization equalises
  groups that may genuinely differ. The console shows per-judge coverage so this is visible, but the
  method does not detect it automatically.
- **It is a location-and-scale correction, not a fairness proof.** It removes systematic severity and
  compression. It cannot recover a judge's misreading of a project.

## 4. What an organizer can and cannot see

| | Own scores | Another judge's scores | Other track | Aggregate | Audit log |
|---|---|---|---|---|---|
| Visitor | ✗ | ✗ | ✗ | ✗ | ✗ |
| Participant | ✗ | ✗ | ✗ | ✗ | ✗ |
| Judge | ✓ | ✗ | ✗ | ✗ | ✗ |
| Organizer | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | via organizer grant | ✓ | ✓ | ✓ | ✓ |

Denied at the query, not in the interface. See `ARCHITECTURE.md`.

Teams receive written feedback once results are published, **without judge
identity attached**, and never see numeric per-judge scores.

---

## 5. Publishing

Computing a snapshot and publishing it are separate, deliberate actions.

`computeSnapshot()` writes an immutable `result_snapshots` row with the
algorithm name and its parameters, plus one `result_rows` per project holding
raw mean, normalized mean, rank, raw rank, movement and review count. Nothing
becomes public.

`publish()` marks one snapshot published, supersedes any previous one and moves
the event to `results_published`. Publishing is confirmed in the interface
before it happens, because it is the one action in the product that is visible
to the whole world. It is reversible: `unpublish()` returns the event to
judging and the standings to private.

Because snapshots are immutable and superseded rather than overwritten, the
history of what was published and when is recoverable.

---

## 6. Honest limitations

- **Pairwise comparison is not implemented.** Bradley–Terry sidesteps cross-judge calibration entirely
  by never asking for an absolute score, and it is a better answer to this problem. It is not here.
- **No inter-rater reliability reporting.** The console shows each judge's bias and spread, but not
  agreement between judges on the same project.
- **The thresholds are defensible defaults, not tuned constants.** `minReviewsForVariance = 3` and
  `minUsableReviewsPerProject = 2` are recorded on every snapshot; they are not editable from the
  interface yet.
- **Ties are broken by raw mean, then project id.** Deterministic, but arbitrary. With genuinely tied
  scores an organizer should decide, not a sort order.
- **Community votes are never mixed into judge scores.** They are a separate projection, published
  separately, and nothing in this document applies to them.
- **Disqualification changes the cohort.** Removing an entry removes its reviews from the
  standardization input, which shifts the judges' own means and spreads slightly. That is correct —
  the statistics should describe the work actually in the running — but it means a snapshot taken
  before a disqualification is not comparable to one taken after. The snapshot records its inputs,
  so the difference is always explainable.
