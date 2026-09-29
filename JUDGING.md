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

*Mean Spearman rank correlation with the true quality. True top five recovered by E: 67%, 66%
and 61% in the biased scenarios, against 64%, 64% and 56% for raw means.*

What the table says:
- **Per-judge z-scores do worse than doing nothing** unless bias is strong. To standardize a
  judge you need their mean and spread, and a spread estimated from three reviews is mostly
  noise. They lose even in the scenario built for them, where judges truly differ in spread.
- **Unshrunk offsets are the worst option.** They overfit the judges with one or two reviews.
- **Shrunk offsets win in every biased scenario**, and when there is no bias at all they cost
  almost nothing (0.900 against 0.904).
- **λ is not a knife-edge choice.** Rank correlation is flat between λ = 0.5 and λ = 3 (0.862 to
  0.865), and λ = 2 sits in that plateau.

| λ | 0 | 0.5 | 1 | **2** | 3 | 5 | 10 | 25 |
|---|---|---|---|---|---|---|---|---|
| rank correlation | 0.699 | 0.863 | 0.865 | **0.864** | 0.862 | 0.858 | 0.852 | 0.848 |

Assumptions of the simulation: quality SD 0.7, judge bias SD 0.5 (0.8 when strong), per-criterion
noise SD 0.8, scores rounded and clamped to 1–5. They are plausible for a 1–5 hackathon rubric
and they are assumptions. The code is short so anyone can change them and rerun.

### On the fixture

| | |
|---|---|
| Reviews used | 121 (the 126 in the file, minus the 5 on the replaced duplicate `prj_07`) |
| Judges in the fit | 29 (`jdg_01`'s only review was of `prj_07`) |
| Overall mean μ | 3.576 |
| Projects that change rank against the raw mean | 29 of 40, by at most 6 places |
| Harshest judges | `jdg_10` −0.39 (3 reviews), `jdg_27` −0.29 (2), `jdg_25` −0.25 (5) |
| Most generous judges | `jdg_02` +0.39 (6), `jdg_15` +0.37 (6), `jdg_13` +0.27 (3) |

Top five: 1 Iron Switch (4.303, raw 4.333), 2 Salt Ledger (4.291, raw 4.333, tied first on raw
mean), 3 Dry Relay (4.185, raw rank 4), 4 Salt Loom (4.088, raw rank 5), 5 Salt Kiln (4.068, raw
rank 6). Raw means always appear beside normalized scores: in the organizer preview, the public
results and the results CSV. [`tests/unit/normalization.test.ts`: *reproduces the documented numbers*]

### Limits, stated plainly

- **This is a model fit, not proof of fairness.** A judge whose projects were all genuinely
  strong is indistinguishable from a generous judge, and will be corrected as one. The model
  can only separate "strong project" from "generous judge" through judges who saw overlapping
  projects. The fixture has that overlap, but a thinly connected event has less.
- **It corrects level, not spread.** A judge who uses only 3–4 and one who uses 1–5 are both
  treated as shifted, not squeezed. The simulation shows that with this little data per judge,
  modelling spread costs more than it gains.
- **λ = 2 was chosen by simulation under stated assumptions**, not derived from first principles.
- **Few reviews mean wide uncertainty.** A project ranked on two reviews is flagged "few reviews"
  (fewer than 2 is the threshold; none on this fixture). How wide, exactly, is the next section.

### How sure the ranking is

A ranking prints one order even when the data cannot tell two projects apart. Forgeboard reports
three things next to it, computed from the same model, seeded, so the same reviews always give
the same numbers. [`src/domain/uncertainty.ts`; `tests/unit/uncertainty.test.ts`]

**1. A 90% interval for every rank.** Fit the model, keep each review's residual
x<sub>jp</sub> − (μ + a<sub>p</sub> + b<sub>j</sub>), and simulate 400 events with the real
judge–project layout: x\*<sub>jp</sub> = μ + a<sub>p</sub> + b<sub>j</sub> + e\*, with e\* drawn
from the residuals. Refit and rank each one; a project's interval is the 5th to 95th percentile
of its simulated places. Two details matter:
- Residuals of a fitted model understate the noise, because the fit used some of the data's
  freedom. They are scaled by √(n / (n − df)), with df = projects + Σ<sub>j</sub> n<sub>j</sub> / (n<sub>j</sub> + λ),
  the effective number of fitted effects under shrinkage.
- Noise is drawn from the pooled residuals rather than by resampling a project's own reviews.
  Resampling one or two reviews would give a project with little evidence a falsely narrow interval.

**2. Podium stability, one judge at a time.** Refit without each judge and ask whether first
place, and the set of the top three, survive. Judges whose removal changes either are named to
the organizer.

**3. The prize line.** For each pair of adjacent places inside the top three: the share of
simulated events that keep their order, and a rough count of extra reviews each would need for
the gap to reach 1.645 standard errors (σ²/n per project, ignoring the uncertainty in judge
offsets, so a lower bound). A pair kept in order less than 90% of the time is shown as a
**statistical tie**, whatever order the table prints.

**On the fixture**, the honest answer is that **this data does not support a confident podium**:

| | |
|---|---|
| Noise in one review (σ) | 0.607 points on the 1–5 scale |
| Iron Switch, rank 1 | 90% interval 1–13; in the top three in 54% of simulations |
| Salt Ledger, rank 2 | 1–15; top three in 47% |
| Widest intervals | projects with two reviews (Copper Orbit, Glass Beacon: 34 places wide) |
| First place without each judge | holds in **22 of 29** refits; the top three hold in 23 of 29 |
| Places 1 and 2 | gap 0.012; order kept in 56% of simulations: a tie at any sample size |
| Places 2 and 3, 3 and 4 | gaps 0.107 and 0.097; kept 59% and 55%; about 171 and 210 more reviews each to separate |

The judges who decide first place are named on the Results page: without `jdg_07` (the flat
4/4/4 judge), `jdg_10` or `jdg_15`, Salt Ledger wins; without `jdg_24`, Open Kiln does; without
`jdg_04`, `jdg_16` or `jdg_25`, Salt Loom, Copper Kiln or Dry Relay do. Nothing is wrong with
these judges. With three or four reviews per project, any one review moves a close top. An
organizer who sees this before publishing can add reviews where the ties are, or announce joint
places, instead of pretending the table is sharper than the evidence.
[`tests/unit/uncertainty.test.ts`: *uncertainty on the DOGFOOD fixture*]

## 4. The awkward cases in the fixture

| Case | What the data shows | Policy |
|---|---|---|
| **A judge who gave everyone the same score** | `jdg_07` (Iva Petrova) scored 4/4/4 on all three reviews (`prj_09`, `prj_17`, `prj_19`). | Flagged **"identical scores"** in red for the organizer. Their reviews still count. Their generosity is absorbed by their offset (+0.26), and they cannot change the order among their own projects, so no extra rule is needed and no data is thrown away. They can still move other projects through the offsets they help estimate: leaving them out hands first place to Salt Ledger, which the podium-stability check reports by name. |
| **A judge whose totals happen to tie** | `jdg_19` (Mira Kaur) gave varied criterion scores, (3,5,3), (3,4,4) and (5,4,2), but under equal weights each totals exactly 11/15. | Flagged **"same total"**, a separate and softer flag. It is a coincidence of the weights, not flat scoring, and it disappears if the organizer reweights the rubric. Found while testing; the flag was split so it does not misdescribe that judge. [`tests/unit/data.test.ts`: *judge flags on the fixture*] |
| **Two unfinished review batches** | The file does not label batches. They show up as uneven coverage: projects with 2 reviews next to projects with 5. | Nothing assumes a complete matrix. Coverage per project and per track is on the live dashboard. Auto-assign can top short projects up. A project with fewer than 2 reviews is still ranked but flagged. Which scores belonged to which batch is not recoverable from the file, and we say so instead of guessing. |
| **A duplicate submission** | `prj_41` "Dry Harbour" resubmits `prj_07` "Dry Harbour", same team `tm_07`, 13 hours later and 3 minutes before the deadline. `prj_07` has 5 reviews and `prj_41` has 4. | **One live project per team, enforced by a unique index.** The latest submission counts. The earlier one is kept, with its reviews, marked *replaced by* `prj_41`, and hidden from the gallery and the ranking. The import writes this to the audit trail, and the organizer can reverse it with one click (also audited). Nothing is merged or deleted. One consequence, stated rather than hidden: `jdg_01` reviewed only `prj_07`, so that judge drops out of the fit while `prj_41` counts. [`tests/http/organizer.test.ts`: *the duplicate decision can be reversed*] |
| **Judges with few reviews** | 7 of the 29 counted judges filed 2 reviews or fewer. | Kept, and flagged "few reviews". Shrinkage keeps their offsets small instead of excluding them. A "3 reviews minimum" rule would throw away those 7 judges and 12 of the 121 reviews. |
| **Teams that share a name** | `tm_03`, `tm_30` and `tm_40` are all "StillTrail", with different members. So are two "AmberSwitch" teams and two "OpenSignal" teams. | Kept as separate teams, since their members differ, and reported at import. New teams created in the portal must choose an unused name. |

## 5. Isolation: who can see which scores

| Who | Can see |
|---|---|
| A judge | Their own assignments and their own scores, in their queue and at `GET /api/judge/scores`. |
| Another judge | Nothing. `GET /api/judge/scores?judge=<someone else>` returns **403**. The review page of another judge's assignment returns **403**. |
| An organizer | Every score in the events they organize, read-only. Organizers cannot score on a judge's behalf. |
| A participant or visitor | Published results only. Before publication the results page says so, and no ranking leaves the server. |

These rules live in the domain layer, which pages and the JSON API both go through. A judge's
queue query is keyed on the caller's id, so there is no parameter to ask for anyone else's.
Refusals are decided from the caller's roles *before* the requested judge is looked up, so a
403 says nothing about whether that judge exists. Every refused attempt to read scores or reviews is written to the event's audit
trail, for example *"Ines Rocha <ines.rocha@example.org> was refused the scores of another judge
(jdg_24)."* It is recorded after the request's transaction has rolled back, so a refused write
cannot take its audit entry down with it. [`tests/http/matrix.test.ts`, `tests/http/checker.test.ts`]

## 6. Publishing

Results stay private while judging runs. The organizer sees a live preview, recomputed on every
load. **Publishing** freezes the ranking into a snapshot and records:
- the method name and version (`additive-offsets-ridge/v1`) and λ
- the rubric weights
- the number of reviews
- every project's rank, normalized score, raw mean and review count
- every judge's offset

- every project's 90% rank interval and top-three share
- a **signed results document** (below)

Publishing also closes judging, so reviews become final. Publishing again supersedes the previous
snapshot without deleting it, and withdrawing results hides them without deleting anything. A
published ranking can therefore be reproduced months later from its own record.

### The method is fixed before anyone sees a score

When the first score of an event is stored, the method, λ, scale and rubric weights are hashed
and written to the audit trail as `method.committed`. At publication the configuration is hashed
again and compared. Organizers can still reweight after scoring starts (raw criterion scores are
kept, and every change is audited), but they cannot retune the method after seeing who is ahead
without the published results saying so: the public results page shows "method unchanged" or
"method changed", and the signed document carries the answer. [`src/domain/commitment.ts`;
`tests/unit/evidence.test.ts`: *method commitment*]

### Results anyone can check without trusting the server

Publishing writes one canonical JSON document and signs it with the instance's Ed25519 key
(`node:crypto`, created on first use). The document holds every rank, score, raw mean and rank
interval, the method, λ and weights, the method commitment, the stability summary, the audit
chain's head at that moment, and a SHA-256 fingerprint of the model's inputs (one weighted score
per review, judges pseudonymized as J01, J02…).

- **`GET /events/<slug>/results.json`** (public once published): the document, its exact text,
  the signature and the public key. `node src/cli.ts verify-results results.json` checks it offline.
- **The results capsule** (organizers, `/organize/<slug>/results/capsule.html`): one HTML file with
  the document, the signature and the pseudonymized inputs. Opened in any current browser, with
  no server and no network, it checks the signature with WebCrypto, hashes the inputs against the
  fingerprint, and **refits the ranking** with the same algorithm restated in 30 lines of inline
  JavaScript. A changed score, rank or review makes a check fail and says which.
  `verify-results` accepts the capsule too.

The audit trail is hash-chained: each entry stores the SHA-256 of the entry before it and its own
fields, so an edit made to the database file (around the append-only triggers) breaks every later
hash. `node src/cli.ts verify-audit` and the Audit page report the first entry that does not
verify. Because the signed document quotes the chain's head at publication, a later rewrite of
history also contradicts every capsule already handed out. What this does not stop, stated in
[THREAT-MODEL.md](THREAT-MODEL.md): someone who controls the server before publication, or who
holds the key and re-signs, and truncation of the newest entries before they are anchored.
[`tests/unit/evidence.test.ts`, `tests/http/evidence.test.ts`]

### A second opinion: pairwise, with Bradley–Terry

Scores carry a judge's scale; comparisons do not. Forgeboard turns every judge's reviews into
comparisons (a judge who scored A above B prefers A; equal scores say nothing) and adds the
explicit choices judges make in **compare mode**, where a judge is shown two of their own
assigned projects and picks the better one. A Bradley–Terry model, P(i beats j) =
π<sub>i</sub> / (π<sub>i</sub> + π<sub>j</sub>), is fitted to all of them with the MM algorithm,
with one virtual win and one virtual loss per project against a reference, which keeps unbeaten
or winless projects finite. Compare mode serves the pair the judge has not compared that has been
compared least overall, then the closest in strength. Choices are final and audited, and judges
compare only their own assigned projects, so track isolation and conflicts carry over.
[`src/domain/pairwise.ts`, `src/domain/compare.ts`; `tests/unit/pairwise.test.ts`, `tests/http/compare.test.ts`]

A comparison is made inside one judge's scale, so **leniency cancels out by construction**, and the
flat judge `jdg_07` (4/4/4) implies no comparisons at all, so it carries no weight, with no rule
needed.

**On the fixture:** the 121 reviews imply 239 comparisons from 25 judges (`jdg_07` and `jdg_19`
imply none). Iron Switch comes first, unbeaten at 16–0, the same winner as the rubric ranking, and
the two orders agree at Spearman ρ = 0.87 over all 40 projects.

**Why it is the second opinion and not the ranking.** [`research/pairwise-study.ts`](research/pairwise-study.ts)
runs the normalization study's scenarios on the fixture's layout ([output](research/pairwise-study-output.md)):

| Rank correlation with truth | Bias only | Bias and spread | Strong bias | No bias |
|---|---|---|---|---|
| Raw mean | 0.840 | 0.835 | 0.763 | **0.904** |
| Offsets, λ = 2 (the ranking) | **0.867** | 0.857 | 0.819 | 0.900 |
| Within-judge Bradley–Terry | 0.810 | 0.811 | 0.809 | 0.817 |
| Mean of the two ranks | 0.864 | **0.861** | **0.846** | 0.877 |

Turning scores into comparisons throws away the size of every gap, so on its own it ranks worse
than the offsets model. What it buys is immunity: its accuracy barely moves as judge bias grows
(0.810 to 0.809), where raw means fall from 0.840 to 0.763. When the two disagree about first
place, the Results page says so. That is the moment to read the certainty section, not to switch
methods. Averaging the two ranks does best under strong bias; we report that and do not ship it as
the default, because it loses when judges are fair.

### The community vote never touches this ranking

The community vote (T3) is a separate tally with its own rules: approval voting, one ballot per
account or voter code, hidden until an organizer publishes it after voting closes. It is never
blended into the judges' ranking, so no number of ballots can move a judged place. See the
README's Tier 3 table and [THREAT-MODEL.md](THREAT-MODEL.md).

## 7. What we would do next

- **A pairwise-only mode** for events large enough that judges compare instead of scoring. The
  engine and compare mode exist; what is missing is running an event without the rubric.
- **Spend extra reviews where the ties are**: the prize-line check already says which pairs are
  ties; auto-assign could target them directly.
- **Conflict declarations** beyond team membership: a judge marking a project as a conflict.
- **Assignment that maximizes overlap between judges**, which strengthens the offset estimates, as
  an explicit objective rather than a side effect of load balancing.
