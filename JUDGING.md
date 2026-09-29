# Judging

How Forgeboard assigns judges, turns scores into a ranking, corrects for harsh and generous
judges, and handles the awkward cases in the DOGFOOD fixtures. Every number on this page comes
from the code in this repository run on the official `fixtures.json`. The tests named in
brackets reproduce them.

```
judges invited ─► tracks granted ─► projects assigned ─► reviews scored ─► weighted score per review
      ─► judge offsets fitted ─► ranking previewed ─► snapshot published (frozen, reproducible)
```

---

## 1. Who judges what: assignment

Organizers invite judges by email and choose the tracks each judge covers. There is no mail
server, so the invite is a one-time link the organizer passes on (§7 of the README). A judge
covering no tracks covers all of them.

**Auto-assignment** (`src/domain/assignment.ts`) fills every project up to the event's target
(`reviews_per_project`, 3 by default) with these rules, in priority order:

1. **Track coverage.** A judge only gets projects in tracks they cover.
2. **Conflict of interest.** A judge never gets a project from a team they are on. The schema
   also refuses the stronger case: nobody can hold the judge role in an event where they are
   on a team, and an organizer cannot also judge (organizers read every score).
3. **No repeats.** A unique index on `(project, judge)` makes a double assignment impossible,
   so a judge can never be counted twice for one project.
4. **Least-covered first, one slot per round.** Projects with the fewest judges are served
   first, one slot each per pass. A shortage is spread across projects instead of starving
   the ones at the end of the list.
5. **Least-loaded judge wins.** Ties are broken by a hash of (event, project, judge): the
   result is deterministic, but `jdg_01` does not absorb every tie the way alphabetical order would.

It keeps existing assignments, so running it twice adds nothing. Anything it cannot fill is
reported with the reason, for example *"Beta Game: 1 of 2, only 1 judge(s) cover this track"*.
Organizers can also assign and unassign by hand. An assignment with a submitted review cannot
be removed: submitted reviews are evidence.

**On the fixture.** The file lists scores, not assignments, so each of the 126 scores is
imported as an assignment with a submitted review. Coverage is uneven, as the fixture intends:
8 current projects have 2 reviews, 26 have 3, 3 have 4 and 3 have 5. Running auto-assign
tops every project up to 3 within the judges' tracks, and those new slots appear in the judges'
queues. [`tests/http/organizer.test.ts`: *auto-assign tops the fixture up*]

## 2. The rubric and the weighted score

Each event has a rubric of criteria with relative weights and one score scale (1–5 by default).
A review's score is the weighted mean of its criterion scores:

$$ x = \frac{\sum_c w_c \, v_c}{\sum_c w_c} $$

With weights 2, 1, 1 and scores 4, 5, 3 that is (2·4 + 5 + 3) / 4 = 4.0.
[`tests/http/lifecycle.test.ts`: *uses the organizer weights 2:1:1*]

- **Raw criterion scores are stored; weighted scores are always computed.** Weights can
  therefore change after scoring starts, and every change is audited with its before and after
  values (*"Functionality weight 1 → 3"*).
- **The set of criteria and the scale lock once the first score exists.** Adding or removing a
  criterion mid-judging would make early and late reviews incomparable, so the server refuses it.
  The database refuses any score outside the event's scale with a trigger, whatever the code does.
- **A published snapshot stores the weights it used**, so a later reweighting never changes a
  published result silently.

The fixture gives three criteria (`functionality`, `quality`, `innovation`, integers 2–5) and no
weights. Forgeboard imports them **equally weighted on a 1–5 scale**. Both are assumptions, stated
here and editable by the organizer.

## 3. Normalization: correcting for harsh and generous judges

### The problem

A project's raw average depends on who happened to review it. In the fixture, judges file between
1 and 11 reviews each, with a median of 3, and each project sees 2 to 5 of them. A project that
drew two harsh judges is ranked below an equal project that drew two generous ones.

### The method: additive judge offsets with ridge shrinkage

Forgeboard fits one model to all submitted reviews of current projects at once
(`src/domain/normalization.ts`):

$$ x_{jp} = \mu + a_p + b_j + \varepsilon_{jp} $$

- μ is the overall mean of all reviews.
- a<sub>p</sub> is project *p*'s effect: how much better or worse it is than average.
- b<sub>j</sub> is judge *j*'s offset: positive means generous, negative means harsh.

It minimizes squared error plus a ridge penalty on the judge offsets:

$$ \min_{a,b} \sum_{(j,p)} (x_{jp} - \mu - a_p - b_j)^2 + \lambda \sum_j b_j^2, \qquad \lambda = 2 $$

by alternating exact block updates (coordinate descent) until nothing moves by more than 10<sup>-12</sup>:

$$ a_p = \operatorname{mean}_{j \in J(p)} (x_{jp} - \mu - b_j), \qquad b_j = \frac{\sum_{p \in P(j)} (x_{jp} - \mu - a_p)}{n_j + \lambda} $$

**Projects are ranked by μ + a<sub>p</sub>**: their score with each judge's fitted offset taken
out, on the same 1–5 scale as the raw mean shown beside it. Ties share a rank (1, 2, 2, 4).

**What λ means.** The denominator n<sub>j</sub> + λ treats every judge as if they had also filed
λ = 2 reviews with zero bias. A judge seen once is barely moved. A judge with eleven reviews is
corrected almost fully. Without this term, the model believes whatever a single review says:
fitted unshrunk on all 126 reviews, `jdg_01` is declared 1.60 points harsh on the strength of one review;
with λ = 2 the same review gives −0.45.

**Properties.**
- *Unique and convergent.* With λ > 0 the objective is strictly convex in (a, b) when every
  project has at least one review, so coordinate descent converges to the one minimum. The
  fixture needs 75 iterations.
- *Deterministic.* Keys are visited in sorted order, so the same reviews produce the same bits
  whatever the input order. [`tests/unit/normalization.test.ts`: *is deterministic*]
- *Everyone counts.* No judge is dropped and no review is discarded. That matters on this data,
  where a third of the judges have two reviews or fewer.
- *Connected.* The fixture's judge–project graph is one connected component, so every offset is
  estimated on a common scale. On a disconnected event the shrinkage still keeps the fit
  defined, and each island's offsets are pulled toward zero rather than floating free.

### A worked example you can check by hand

Two judges, two projects, every judge sees every project. Judge A is exactly one point more generous.

| | p1 | p2 |
|---|---|---|
| judge A | 4 | 3 |
| judge B | 3 | 2 |

μ = 3. By symmetry b<sub>A</sub> = −b<sub>B</sub>, so a<sub>1</sub> = +0.5 and a<sub>2</sub> = −0.5.
Then b<sub>A</sub> = ((4 − 3 − 0.5) + (3 − 3 + 0.5)) / (2 + 2) = **+0.25** and
b<sub>B</sub> = **−0.25**: half of the one-point gap, because two reviews each are thin evidence.
With λ = 0 the full ±0.5 comes back. [`tests/unit/normalization.test.ts`: *hand-computed cases*]

### Why this method: the evidence

The alternatives were tested on the fixture's own judge–project layout.
`research/normalization-study.ts` keeps exactly who reviewed what (121 reviews, 40 projects,
29 judges). It invents a known true quality per project and a bias per judge, then generates
integer 1–5 criterion scores from them and checks each method's ranking against the truth,
over 300 simulated events per scenario. It is seeded, so `npm run study` prints the same tables
every time (`research/normalization-study-output.md`).

| Method | Bias only | Bias and spread (×0.5–×2) | Strong bias | No bias (null case) |
|---|---|---|---|---|
| A. Raw mean | 0.840 | 0.835 | 0.763 | **0.904** |
| B. Per-judge z-score, judges with ≥ 3 reviews | 0.803 | 0.802 | 0.801 | 0.807 |
| C. Per-judge z-score, judges with ≥ 2 reviews | 0.808 | 0.807 | 0.805 | 0.813 |
| D. Offsets, no shrinkage (λ = 0) | 0.700 | 0.705 | 0.701 | 0.715 |
| **E. Offsets, λ = 2 (Forgeboard)** | **0.867** | **0.857** | **0.819** | 0.900 |
| F. Offsets, λ = 5 | 0.860 | 0.852 | 0.801 | 0.903 |

