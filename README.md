# Forgeboard

**A self-hosted hackathon submission and judging portal that enforces its own rules.** Teams
submit before a deadline that actually holds. Judges score against a weighted rubric and never
see each other's work: the backend refuses, not the template. The ranking corrects for harsh and
generous judges with a method that is written down, tested, and chosen by simulation on the
DOGFOOD fixture data.

| | |
|---|---|
| **Tiers** | Claims **T1 and T2**. The official checker says `claimed T1 T2, verified T1 T2` ([`acceptance-report.txt`](acceptance-report.txt)) |
| **One command** | `docker compose up`: seeded with the DOGFOOD fixtures, works with the network off |
| **Dependencies** | **Zero at runtime.** Node 24's standard library (`node:http`, `node:sqlite`, `node:crypto`). No `npm install`, no build step |
| **Tests** | **145 of our own** (`npm test`), plus a 16-check headless browser pass and a network-off proof |
| **Judging** | Weighted rubric, backend isolation, live dashboard, **additive judge offsets with ridge shrinkage** ([JUDGING.md](JUDGING.md)), CSV at every stage |
| **Bonus work** | Normalization Proof ([JUDGING.md §3](JUDGING.md#3-normalization-correcting-for-harsh-and-generous-judges)) and Threat Model ([THREAT-MODEL.md](THREAT-MODEL.md)) |
| **Licence** | MIT |

## Contents

1. [Evaluate it in ten minutes](#1-evaluate-it-in-ten-minutes)
2. [Demo accounts and what to try](#2-demo-accounts-and-what-to-try)
3. [What it does](#3-what-it-does)
4. [Who can see what: backend-enforced isolation](#4-who-can-see-what-backend-enforced-isolation)
5. [Judging integrity in one page](#5-judging-integrity-in-one-page)
6. [How it is built](#6-how-it-is-built)
7. [Verification: what we ran and what it said](#7-verification-what-we-ran-and-what-it-said)
8. [Running it for a real event](#8-running-it-for-a-real-event)
9. [Getting data in and out](#9-getting-data-in-and-out)
10. [Developing without Docker](#10-developing-without-docker)
11. [Troubleshooting](#11-troubleshooting)
12. [Where to look, by scoring criterion](#12-where-to-look-by-scoring-criterion)
13. [Honest limitations](#13-honest-limitations)
14. [Documents in this repository](#14-documents-in-this-repository)

---

## 1. Evaluate it in ten minutes

### Step 0: what you need

| Tool | Why | Check |
|---|---|---|
| Docker with Compose v2 (Docker Desktop, or Docker Engine plus the compose plugin) | Runs the portal | `docker compose version` |
| Python 3, any version | Runs the official `run.py` checker (standard library only) | `python3 --version` |
| Port **8080** free | The portal listens there, and `.dogfood.toml` points there | `lsof -i :8080` shows nothing |

The only thing Docker downloads is the `node:24-alpine` base image. There is no `npm install` in
the image, so once that base image is on the machine, the portal builds and runs with the network
off. To prepare a laptop for an offline evaluation, run this once while online:

```sh
docker pull node:24-alpine
```

### Step 1: start the portal

```sh
git clone https://github.com/Avi36005/DogFood-2026.git forgeboard
cd forgeboard
docker compose up
```

The first start imports `fixtures.json` and prints the sign-ins the checker uses:

```text
Forgeboard is listening on http://localhost:8080
imported evt_01 from fixtures.json: 41 projects, 40 teams, 30 judges, 126 scores
  duplicate submission: prj_07 replaced by prj_41 (team tm_07)
  note: teams tm_03, tm_30, tm_40 share a name; they have different members, so they are kept as separate teams
  note: teams tm_05, tm_34 share a name; they have different members, so they are kept as separate teams
  note: teams tm_11, tm_16 share a name; they have different members, so they are kept as separate teams

seeded. test logins:
  organizer    Cookie: session=org_demo_7f2a9c41d8e3b6a5
  judge_a      Cookie: session=jdg_a_demo_91bc5e0f27d4a8c3
  judge_b      Cookie: session=jdg_b_demo_44de83a1c9f06b72
  participant  Cookie: session=prt_demo_2e88b7d14c6f3a19

demo accounts (password "forgeboard-demo"):
  admin        admin@forgeboard.local
  organizer    organizer@forgeboard.local
  judge_a      diego.herrera@example.org
  judge_b      ines.rocha@example.org
  participant  priya1@example.org

DEMO MODE: these sign-ins are public. Never enable FORGEBOARD_DEMO on an instance with real data.
```

The import notes are the fixture's awkward cases being handled on purpose (see
[section 5](#5-judging-integrity-in-one-page)). Open **http://localhost:8080**.

### Step 2: run the official checker

In a second terminal, from the repository root:

```sh
python3 run.py .dogfood.toml
```

```text
DOGFOOD 2026 acceptance report
portal: http://localhost:8080
claimed: T1 T2
fixtures: fixtures.json

T1  gallery is public ................. PASS
T1  project from fixtures shown ....... PASS
T1  closed event refuses submissions .. PASS
T2  judge sees own scores ............. PASS
T2  judge cannot see peer scores ...... PASS
T2  participant blocked ............... PASS
T2  csv export works .................. PASS

claimed T1 T2, verified T1 T2
```

`run.py` and `fixtures.json` are the organizers' published files, unmodified (sha256 prefixes
`aa98963841bc8e18` and `252896bc45d49fca`). The committed
[`acceptance-report.txt`](acceptance-report.txt) is this output.

### Step 3: try to break the isolation yourself

The checker's most important check, by hand. Judge B asks for judge A's scores:

```sh
curl -i -H 'Cookie: session=jdg_b_demo_44de83a1c9f06b72' \
  'http://localhost:8080/api/judge/scores?judge=jdg_24'
```

```text
HTTP/1.1 403 Forbidden        (headers trimmed)
{ "error": "You can read only your own scores. Another judge's scores are visible to organizers only.", "status": 403 }
```

The refusal is decided from judge B's roles *before* judge A is looked up, so the same 403 comes
back for a judge id that does not exist. It is also written to the event's audit trail. More to try:

```sh
# Judge A reads their own scores: 200 and JSON
curl -H 'Cookie: session=jdg_a_demo_91bc5e0f27d4a8c3' http://localhost:8080/api/judge/scores

# A participant is not a judge: 403
curl -i -H 'Cookie: session=prt_demo_2e88b7d14c6f3a19' http://localhost:8080/api/judge/scores

# A late submission is refused for being late: 403 "Submissions for Sample Hack 2026 closed on 1 Mar 2026, 18:00 UTC."
curl -i -X POST -H 'Cookie: session=prt_demo_2e88b7d14c6f3a19' -H 'Content-Type: application/json' \
  -d '{"title":"late","summary":"x"}' http://localhost:8080/projects/new

# The organizer exports each judge's reviews, mean, fitted offset and flags as CSV
curl -H 'Cookie: session=org_demo_7f2a9c41d8e3b6a5' 'http://localhost:8080/api/export.csv?kind=judges'

# Every JSON endpoint, described by the server itself
curl http://localhost:8080/api
```

Then sign in as the organizer and open **Sample Hack 2026 → Audit trail**. The refused attempts
you just made are there, in plain sentences.

### Step 4: run our tests, with nothing but Docker

```sh
docker run --rm -v "$PWD":/app -w /app node:24-alpine npm test
```

```text
ℹ tests 145
ℹ pass 145
ℹ fail 0
```

It takes about 15 seconds. The tests start their own servers on random ports with throwaway
databases, so they never touch the running portal or its data.

### Step 5: prove the network-off rule (optional)

```sh
sh scripts/offline-check.sh
```

```text
1. building with --network none
2. starting a container with --network none
3. checking from inside the container
   health: ok
   gallery projects: 40
   judge_a scores: 11
   csv header: rank,project_id,title,team,track,reviews,raw_mean,normalized_score,raw_rank,low_coverage,status
   egress: none, as intended
offline check passed
```

It builds the image with networking disabled and runs it in a container with no network interface.
Then it confirms from inside that the portal seeded itself and serves the gallery, judge scores
and CSV, and that an outbound request fails.

### Step 6: walk one full event lifecycle

[DEMO-SCRIPT.md](DEMO-SCRIPT.md) is a click-by-click, five-minute run: create an event, form a
team, submit, invite a judge, close submissions, auto-assign, score, publish and export. Start it
on a clean volume so the timestamps are fresh:

```sh
docker compose down -v && docker compose up
```

---

## 2. Demo accounts and what to try

Every demo account's password is `forgeboard-demo`. Use one private window per person, or sign
out and back in.

| Role | Sign in as | What to try |
|---|---|---|
| **Administrator** | `admin@forgeboard.local` | **Events → Create an event** with a deadline ten minutes away, then run the whole lifecycle on it |
| **Organizer** | `organizer@forgeboard.local` | Sample Hack 2026: the live **Overview**, **Rubric** weights, **Assignments → Fill gaps automatically**, **Results** (raw vs normalized), **Audit trail**, **Export** |
| **Judge A** | `diego.herrera@example.org` (`jdg_24`, 11 reviews) | The judging queue, and the scoring form (arrow keys move between scores) |
| **Judge B** | `ines.rocha@example.org` (`jdg_29`, shares no project with judge A) | Open one of judge A's review URLs: 403 |
| **Participant** | `priya1@example.org` (captain of NorthKiln, "Glass Signal") | The team page; the closed event refuses every change, by page and by API |
| **Visitor** | nobody | The gallery: search, event and track filters and ordering, all in the URL so they can be shared |

---

## 3. What it does

### Tier 1: core

| Requirement | How Forgeboard does it |
|---|---|
| Authentication and sessions | Email and password hashed with scrypt. Server-side sessions: the database stores only a SHA-256 of the cookie. Sign-out ends a session at once, a password change ends every other session, and sign-in is rate limited |
| A real role model | Visitor, participant, judge and organizer **per event**, plus an instance administrator. The same account can compete in one event and judge another. A judge cannot be on a team in the event they judge, and an organizer cannot judge it |
| Events with dates, tracks and prizes | Administrators create events with opening, deadline and judging-close times (UTC), tracks, prizes (optionally per track), a team size limit and a target number of reviews per project |
| Teams by invite link | A captain creates a team and shares a link. The link works for several people until the team is full, expires after 14 days, and stops working when the captain makes a new one. Only a hash of it is stored |
| Draft and edit until the deadline | Drafts are private: 404 to everyone except the team and the event's organizers. Submitted projects are public and editable until the deadline. Concurrent edits by teammates get a 409 instead of silently overwriting each other, and every save goes into an append-only revision history |
| A deadline that holds | Every write that touches a team or a project checks the **server clock inside the same transaction** as the write, for pages and the JSON API alike. A late request is refused *for being late*, whatever else is wrong with it. The client's clock is never consulted |
| Public gallery with search and filter | Server-rendered, so the fixture titles are in the HTML curl receives. Search, event and track filters, and ordering, all shareable by URL. All 40 fixture projects are on page one |

### Tier 2: judging

| Requirement | How Forgeboard does it |
|---|---|
| Judge invitation and assignment | One-time invite links, since there is no mail server. Judges cover chosen tracks. **Auto-assign** is track-aware and conflict-free, balances load, and serves the least-covered projects first. It reports anything it could not fill, and why. Manual assign and unassign are there too |
| A weighted rubric the organizer configures | Criteria with relative weights and a score scale. Criteria and scale lock once the first score exists; weights stay adjustable, and every change is audited with its before and after values |
| Backend role isolation | A judge's queries are keyed on the caller's own id. Other judges' scores and review pages return **403**, decided before the target is looked up, and the attempt lands on the audit trail. See [section 4](#4-who-can-see-what-backend-enforced-isolation) |
| Live organizer dashboard | Refreshes every 10 seconds: submissions, reviews done, coverage per project and per track, each judge's progress, and flags ("identical scores", "same total", "few reviews", "harsh", "generous") |
| Normalization, documented | Additive judge offsets with ridge shrinkage (λ = 2), chosen by simulation on the fixture's own judge layout. Raw means always sit beside normalized scores. See [section 5](#5-judging-integrity-in-one-page) and [JUDGING.md](JUDGING.md) |
| CSV export | At every stage: results, reviews, projects, judges, assignments and the audit trail. Cells a spreadsheet would run as formulas are neutralized |

**Also built:** publishing freezes a snapshot (method, λ, weights, every rank and every judge
offset), so a published ranking can be reproduced later. Republishing supersedes a snapshot
without deleting it. The audit trail is readable by an organizer without a database client and is
append-only *in the database*: triggers reject `UPDATE` and `DELETE`.

**Not claimed:** T3 (community voting, comments) and T4 (webhooks, certificates, embeds). See
[section 13](#13-honest-limitations).

---

## 4. Who can see what: backend-enforced isolation

Every cell below is asserted by [`tests/http/matrix.test.ts`](tests/http/matrix.test.ts), which
sends real requests as each role and checks the status code.

| Actor | Own scores | Another judge's scores | Another judge's review page | Organizer dashboard and results preview | Audit trail and CSV exports |
|---|---|---|---|---|---|
| Visitor | 401 | 401 | sent to sign-in | sent to sign-in | 401 (API), sign-in (pages) |
| Participant | 403 | 403 | 403 | 403 | 403 |
| Judge | **200** | **403**, audited | **403** | 403 | 403 |
| Organizer of that event | n/a (organizers do not judge) | 200, read-only | 200, read-only | 200 | 200 |
| Administrator | Instance-wide: accounts, creating events, appointing organizers. Reading an event's scores needs the organizer role *in that event*, and appointing one (even oneself) is written to that event's audit trail | | | | |

What makes these hold:
- **Authorization lives in the domain layer, not in routes or templates.** Every page, the JSON
  API and the tests call the same domain functions, and each one starts with the check it needs.
  A route that forgot a check could not leak, because the function it calls refuses the caller.
- **A judge's queue is `WHERE a.judge_id = <the caller>`.** There is no parameter to ask for
  somebody else's. Auto-assign only gives a judge projects in the tracks they cover.
- **No existence oracle.** A 403 says nothing about whether the requested judge or review exists.
- **Organizers cannot score on a judge's behalf.** A `POST` to another judge's review is 403 for
  everyone, organizers included.
- **Refusals are recorded after the transaction rolls back,** so a denied write can never take its
  own audit entry down with it.

---

## 5. Judging integrity in one page

### The method

Each review's score is the weighted mean of its criterion scores. Forgeboard then fits one model to
every submitted review of the current projects:

$$ x_{jp} = \mu + a_p + b_j + \varepsilon_{jp}, \qquad \min_{a,b} \sum (x_{jp} - \mu - a_p - b_j)^2 + \lambda \sum_j b_j^2, \quad \lambda = 2 $$

Here a<sub>p</sub> is how good project *p* is, and b<sub>j</sub> is how generous judge *j* is.
Projects are ranked by **μ + a<sub>p</sub>**: their score with each judge's offset taken out, on
the same 1–5 scale as the raw mean shown beside it. The ridge term treats every judge as if they
had also filed two unbiased reviews. A judge seen once is barely moved, and a judge seen eleven
times is corrected almost fully. The fit is convex, deterministic (the same reviews give the same
bits in any order) and converges in 75 iterations on the fixture. The full derivation, a worked
example you can check by hand, and the stated limits are in [JUDGING.md](JUDGING.md).

### Why this method: the evidence

We did not pick it by taste. [`research/normalization-study.ts`](research/normalization-study.ts)
keeps the fixture's exact judge–project layout (121 reviews, 40 projects, 29 judges), invents a
known true quality for each project and a bias for each judge, and checks each method's ranking
against the truth over 300 simulated events per scenario. It is seeded, so `npm run study`
reproduces [its output](research/normalization-study-output.md) exactly.

| Method | Judges differ in bias | Bias and spread | Strong bias | No bias at all |
|---|---|---|---|---|
| Raw mean | 0.840 | 0.835 | 0.763 | **0.904** |
| Per-judge z-score (judges with ≥ 3 reviews) | 0.803 | 0.802 | 0.801 | 0.807 |
| Offsets, no shrinkage (λ = 0) | 0.700 | 0.705 | 0.701 | 0.715 |
| **Offsets, λ = 2 (Forgeboard)** | **0.867** | **0.857** | **0.819** | 0.900 |

