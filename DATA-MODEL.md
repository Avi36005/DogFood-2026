# Data model

One SQLite database (`/data/forgeboard.db` in Docker), created by
[`src/db/migrations/001_initial.sql`](src/db/migrations/001_initial.sql), which is the
authoritative version of everything below. This page explains it.

**Conventions**
- **Ids** are opaque text. Rows imported from `fixtures.json` keep their fixture ids (`evt_01`,
  `prj_07`, `jdg_24`). New rows get a prefix and 12 random characters (`prj_k3v9x2m1qa7d`).
- **Times** are UTC ISO 8601 strings with milliseconds, which sort correctly as text. Pages
  show UTC with the zone written out.
- **Every row that belongs to an event carries `event_id`.** Composite foreign keys use it, so
  the database itself refuses a project in another event's track, or an assignment to someone
  who is not a judge of that event.
- **Raw data is never overwritten by derived data.** Criterion scores are stored, and weighted
  and normalized scores are computed. Published results are separate, immutable snapshots.

## Tables

```
users ─┬─ sessions            events ─┬─ tracks ─── prizes
       ├─ password_links              ├─ criteria
       └─ event_roles ────────────────┤  (organizer | judge | participant)
            │                         ├─ teams ─── team_members, team_invites
            ├─ judge_tracks           ├─ projects ─── project_revisions
            ├─ judge_invites          ├─ assignments ─── reviews ─── review_scores
            └─ assignments            ├─ result_snapshots ─── result_rows, result_judge_offsets
                                      └─ audit_log (no foreign keys: outlives what it describes)
```

### Identity

| Table | Purpose | Rules it carries |
|---|---|---|
| `users` | One account per email | Email unique (case-insensitive). `password_hash` is NULL until the person claims the account through a one-time link, which is how imported and invited people exist. `is_admin` is instance-wide |
| `sessions` | Server-side sessions | Keyed by the **SHA-256 of the cookie value**; the cookie itself is never stored. `is_demo` marks the four fixed checker sessions |
| `password_links` | One-time links to set a password (`setup`) or reset one (`reset`) | Hashed, expiring, single-use (`used_at`) |
| `settings` | The generated CSRF signing secret | |

### Events and roles

| Table | Purpose | Rules it carries |
|---|---|---|
| `events` | A hackathon: slug, name, texts, `submissions_open_at`, **`submissions_close_at`** (the deadline), `judging_close_at`, `results_published_at`, team size, reviews per project, score scale | `slug` unique and URL-safe. The opening time must come before the deadline, and the scale must be ordered. `source` is `created` or `fixture` |
| `event_roles` | Who is what in which event | Primary key `(event, user, role)`. A visitor is the absence of a row |
| `tracks` | Tracks per event | `UNIQUE (id, event_id)`, the target of composite foreign keys |
| `prizes` | Prizes, optionally for one track | `(track_id, event_id)` must name a track of the same event |

### Teams and projects

| Table | Purpose | Rules it carries |
|---|---|---|
| `teams` | Teams per event | **Names are not unique.** The fixture has three pairs of different teams sharing a name, so uniqueness is a rule for new teams in the code, not a database invariant |
| `team_members` | Membership | `UNIQUE (event_id, user_id)`: one team per person per event. `is_captain` marks the captain |
| `team_invites` | Invite links | Hashed. Multi-use until expiry (14 days), replacement or a full team |
| `projects` | Submissions: title, summary, description, track, three links, `status` (`draft` / `submitted` / `withdrawn`), `submitted_at`, **`superseded_by`**, `version` | A **partial unique index gives one live project per team** (`WHERE superseded_by IS NULL AND status <> 'withdrawn'`). `submitted` requires `submitted_at`. The track must belong to the same event. `version` supports optimistic concurrency |
| `project_revisions` | A JSON snapshot of every save | **Append-only**: triggers reject `UPDATE` and `DELETE`. It answers "what did this team have at the deadline?" |

### Judging

| Table | Purpose | Rules it carries |
|---|---|---|
| `criteria` | The rubric: key, name, description, relative weight | Weight between 0 and 100. `UNIQUE (event_id, key)` |
| `judge_tracks` | Which tracks a judge covers | The foreign key `(event_id, judge_id, 'judge')` → `event_roles` requires the judge role, and removing the role removes the grants |
| `judge_invites` | One-time judge invitations | Hashed, expiring, `accepted_at` |
| `assignments` | Judge × project | **`UNIQUE (project_id, judge_id)`**: never twice. The judge must hold the judge role *in that event*, and the project must be in that event (both composite foreign keys). There is deliberately no cascade from the role, so a judge with reviews cannot vanish silently. `source` is `fixture`, `auto` or `manual` |
| `reviews` | One per assignment: `draft` or `submitted`, comment | `submitted` requires `submitted_at` |
| `review_scores` | Criterion × review → integer | Primary key `(review, criterion)`. **Triggers** refuse a criterion from another event and a value outside the event's scale |

### Results and audit

| Table | Purpose | Rules it carries |
|---|---|---|
| `result_snapshots` | A published ranking: method, λ, weights (JSON), review count, who and when; the signed results document (exact text), its Ed25519 signature and public key, and the model's inputs (pseudonymized, JSON) | At most one current snapshot per event (a partial unique index). Older ones are kept with `superseded_at`. The inputs are never selected into public responses |
| `result_rows` | Rank, normalized score, raw mean, review count, low-coverage flag, 90% rank interval (`rank_lo`, `rank_hi`) and top-three share per project | |
| `result_judge_offsets` | Each judge's fitted offset in that snapshot | Makes a published ranking reproducible |
| `audit_log` | Every change and every refused attempt: when, who (id and a readable label), event, action, subject, a one-sentence summary, JSON detail, IP, and `prev_hash`/`hash` | **Append-only** (triggers reject `UPDATE` and `DELETE`) and **hash-chained**: `hash` = SHA-256 of `prev_hash` and the entry's fields, so an edit made around the triggers shows. It has no foreign keys on purpose: the record must outlive what it describes |

### Community (T3)

| Table | Purpose | Rules it carries |
|---|---|---|
| `vote_settings` | One per event with a community vote: window, access (`accounts` or `codes`), approvals per ballot, when the tally was published | `closes_at > opens_at`; `max_picks` 1–10 |
| `voter_codes` | One-time voter codes, by batch | Stored only as SHA-256 hashes; `used_at` set once, in the ballot's transaction |
| `ballots` | One per voter: account **or** code, time, keyed hashes of address and browser, void reason | Exactly one of account and code (a `CHECK`); **one per account per event** and **one per code** (partial unique indexes); voided only with a reason |
| `ballot_picks` | The projects a ballot approves | **Final**: triggers reject `UPDATE` and `DELETE` |
| `comments` | Comments on projects | 1–2,000 characters; hidden only with a reason and who hid it, never deleted |
| `pairwise_votes` | Compare mode: which of two assigned projects a judge chose | **One per judge per unordered pair** (an expression index over `min`/`max` of the two ids); **final** (triggers) |

JSON appears in exactly five places, each an immutable record rather than a data model:
- `project_revisions.snapshot`
- `result_snapshots.weights`, `result_snapshots.document` (the signed text) and `result_snapshots.inputs`
- `audit_log.detail`

All five are checked with `json_valid`. Migration `002_evidence.sql` adds the chain, interval and
signature columns with `ALTER TABLE … ADD COLUMN`, so an existing database upgrades in place;
audit entries written before it are reported as unchained, never silently accepted.

## Rules the database enforces, whatever the code does

| Rule | How | Test |
|---|---|---|
| One live project per team (the duplicate case) | Partial unique index | `tests/unit/data.test.ts`: *a team cannot have two live projects* |
| A judge scores a project at most once | `UNIQUE (project_id, judge_id)` | *the same judge cannot be assigned the same project twice* |
| Only judges of that event are assigned | Composite FK to `event_roles(event, user, 'judge')` | *a judge cannot be assigned without holding the judge role* |
| No cross-event references | Composite FKs on `(id, event_id)` | *a project cannot point at another event's track* |
| Scores stay in the event's scale | Trigger on `review_scores` | *a score outside the event scale is rejected* |
| The audit log and revision history are append-only | Triggers | *the audit log is append-only* |
| A failed operation leaves nothing behind | One transaction per domain operation | *a transaction that fails leaves nothing behind* |

## The way in

- **The DOGFOOD fixtures format** (`src/domain/fixtures.ts`), at first start
  (`FORGEBOARD_SEED_FIXTURES=1`) or with `node src/cli.ts import <file>`.
  1. **The whole file is validated first:** the shape, then every cross-reference (unknown team,
     track or judge), a judge who is also on a team, a judge scoring a project twice, scores
     outside 1–5, and inconsistent criteria sets. Every problem is listed.
  2. **Then it is written in one transaction.** A bad file changes nothing.
  3. **Importing the same event again is a no-op.**

  The mapping:
  - Judges become users with their fixture ids, plus the judge role and their tracks.
  - Team members become users without passwords, who can claim their accounts with a link.
  - Each score becomes an assignment plus a submitted review.
  - The criteria become an equally weighted rubric on a 1–5 scale.
  - A team with more than one project keeps the latest live and marks the rest replaced
    (JUDGING.md §4).
- **Accounts** can be created by sign-up, by invitation (judges), or by import.

## The way out

- **CSV at every stage** (organizers; the **Export** tab or `GET /api/export.csv?event=<id>&kind=<kind>`):

  | Kind | Contents |
  |---|---|
  | `results` | The ranking with raw means, normalized scores and raw ranks |
  | `reviews` | Every review with each criterion, the weighted score and the comment |
  | `projects` | Every project, including drafts and replaced ones |
  | `judges` | Tracks, progress, fitted offset and flags |
  | `assignments` | Who reviews what, and how each assignment was made |
  | `audit` | The event's full audit trail |

  Files are RFC 4180, UTF-8, with CRLF line endings. Formula-like cells are neutralized.
- **The whole database:** `node src/cli.ts backup <file>` writes a consistent copy while the
  server runs. It is a plain SQLite file, readable by any SQLite tool, and every table is
  described above.
- **JSON:** `GET /api/events`, `/api/events/<id>`, `/api/projects` and the published results.
  See `GET /api`.

## Migrations

Migrations are forward-only SQL files in `src/db/migrations/`. Each runs in its own
transaction on start and is recorded in `schema_migrations`. Adding a feature means adding
`002_….sql`; the shipped schema is never edited in place.
