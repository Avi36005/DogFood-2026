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
| `result_snapshots` | A published ranking: method, λ, weights (JSON), review count, who and when | At most one current snapshot per event (a partial unique index). Older ones are kept with `superseded_at` |
| `result_rows` | Rank, normalized score, raw mean, review count and low-coverage flag per project | |
| `result_judge_offsets` | Each judge's fitted offset in that snapshot | Makes a published ranking reproducible |
| `audit_log` | Every change and every refused attempt: when, who (id and a readable label), event, action, subject, a one-sentence summary, JSON detail, IP | **Append-only** (triggers reject `UPDATE` and `DELETE`). It has no foreign keys on purpose: the record must outlive what it describes |

JSON appears in exactly three places, each an immutable record rather than a data model:
- `project_revisions.snapshot`
- `result_snapshots.weights`
- `audit_log.detail`

All three are checked with `json_valid`.

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

