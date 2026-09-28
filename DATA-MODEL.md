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

