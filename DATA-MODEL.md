# Data model

SQLite, `STRICT` tables, foreign keys on. The whole schema is one readable file:
[`lib/db/schema.sql`](lib/db/schema.sql). This document explains the decisions
behind it and how data gets in and out.

## Conventions

- **Ids** are text, prefixed by kind: `usr_`, `evt_`, `prj_`, `asg_`, `rvw_`.
  Self-describing in logs and in a CSV, and impossible to confuse across tables.
  Generated from a base-36 timestamp plus 8 random characters, so they sort
  roughly by creation without being guessable.
- **Timestamps** are UTC ISO-8601 strings. SQLite has no date type; a sortable
  lexicographic format is the honest choice. `events.timezone` is display only.
- **`STRICT`** on every table, so a text column cannot quietly accept an
  integer. Enumerations are `CHECK` constraints rather than convention.
- **Booleans** are `INTEGER` constrained to `(0,1)`.
- **Soft state** (`disabled_at`, `revoked_at`, `withdrawn_at`) is a nullable
  timestamp rather than a flag, so "when" is never lost.

## Entities

### Identity

**`users`** — `email_ci` is a lowercased uniqueness key beside the display
`email`, so addresses are case-insensitive for login while preserving what the
person typed. `password_hash` / `password_salt` are hex scrypt output.
`global_role` is `admin` or `user` and confers no event powers by itself.

**`sessions`** — server-side. Stores `token_hash` (SHA-256 of the cookie value),
never the token. Revocation is a column, so disabling an account kills its
sessions immediately.

**`password_resets`** — local account recovery. One row per issued link:
`token_hash` (never the token), who issued it (`created_by`, null when the
operator issued it from the command line), an expiry an hour out, and `used_at`.
Redeeming one sets the new password, marks every outstanding link for that
account used, and revokes every session it had.

### Events

**`events`** — the aggregate root. Four independent timestamps
(`submissions_open_at`, `submissions_close_at`, `judging_open_at`,
`judging_close_at`) rather than deriving windows from `status`, because an
organizer routinely wants submissions closed while judging has not started.
`reviews_per_project` and `max_team_size` are policy, configurable per event,
not constants in code. `version` supports optimistic concurrency.

**`tracks`**, **`prizes`**, **`custom_questions`** — all keyed to the event and
cascade-deleted with it. A prize may be scoped to a track or to the whole event.
Questions carry a `kind` so the form can render the right control, and
`options_json` for select types.

**`event_roles`** — the authorization table.

```sql
CREATE UNIQUE INDEX ux_event_roles
  ON event_roles(event_id, user_id, role, IFNULL(track_id,''));
```

A row is `(event, user, role[, track])`. A `judge` row with `track_id IS NULL`
judges everything; with a track it is confined to that track. The `IFNULL` in
the index is what makes "all tracks" and "this track" distinct grants rather
than colliding on `NULL`, since SQLite treats `NULL`s as distinct in unique
indexes.

**Why not a `role` column on `users`?** Because roles are per event. The same
person is an organizer here and a competitor there. Putting role on the user
would force one instance per event, which defeats the point.

### Teams

**`teams`** — unique name within an event.
**`team_members`** — unique `(team_id, user_id)`; `role` is `owner` or `member`.
An owner cannot leave while others remain, which prevents orphaned teams.

**`invitations`** — stores `token_hash`, never the token. Carries `expires_at`,
`max_uses` and `uses`, so a link can be time-boxed and rate-limited rather than
being a permanent key. Accepting runs in one transaction: seat check, insert,
counter increment.

### Submissions

**`projects`** — one per team, enforced by `UNIQUE(team_id)`. The gallery,
assignment and scoring all assume it, so it is a constraint rather than a habit.
Carries the full field set the brief names: name, tagline, description,
thumbnail, demo video URL, repository URL, live URL, track. `status` is
`draft` / `submitted` / `withdrawn`.

**`project_tags`** — a join table with `PRIMARY KEY (project_id, tag)`, not a
comma-separated column, so filtering by tag is an index lookup.

**`custom_answers`** — unique per `(project, question)`, upserted.

**`submission_revisions`** — append-only JSON snapshot per submit, numbered per
project. This is what lets an organizer answer "what was on file at the
deadline?" after a team has kept editing.

**`media_assets` / `project_media`** — tables exist with a `sha256` for
deduplication; upload is **not wired up** in the interface. Declared honestly
rather than removed, because the gallery schema anticipates it.

### Judging

**`rubric_versions` / `criteria`** — rubrics are versioned, not edited in place.
Publishing supersedes the previous version; reviews keep the
`rubric_version_id` they were scored against. Without this, editing a weight
mid-event would silently rewrite history.

**`assignments`** — `UNIQUE(project_id, judge_user_id)`. `batch_label` records
which generation run produced it. Revocation is a status plus a timestamp, so a
withdrawn assignment stays visible in the audit rather than vanishing.

**`reviews`** — `UNIQUE(assignment_id)`: one review per assignment, which is
what makes "one ballot per judge per project" a database fact.
`raw_weighted` caches the weighted score at submit time so later rubric changes
cannot retroactively alter a submitted score.

**`criterion_scores`** — `UNIQUE(review_id, criterion_id)`, upserted as a judge
works. `score` is `REAL` to allow non-integer scales later.

### Results

**`result_snapshots`** — immutable. Records `algorithm` and `params_json`, so a
published ranking carries the parameters that produced it. Status is
`computed` / `published` / `superseded`; publishing supersedes rather than
overwrites.

**`result_rows`** — per project per snapshot: `raw_mean`, `normalized_mean`,
`rank`, `raw_rank`, `rank_delta`, `reviews_counted`, `rank_in_track`. Storing
both rankings is what makes the normalization auditable after the fact.

### Community (T3)

**`voters`** — one row per distinguishable voter per event, with `kind` recording how much that
identity is actually worth (`session`, `email`, `account`). Partial unique indexes keep one voter per
account, per address and per browser cookie, without those columns colliding on `NULL`.

**`vote_tokens`** — expiring, single-use possession proofs for email-gated voting. Hash stored, never
the token. Delivery is the operator's channel; Forgeboard sends no mail.

**`votes`** — the uniqueness that matters is partial:
`UNIQUE(project_id, voter_id) WHERE retracted_at IS NULL AND invalidated_at IS NULL`. A retracted or
invalidated vote stays in the table for the audit trail while freeing the slot, so history is never
destroyed to allow a re-vote.

**`comments`** — `status` is `visible`/`removed`. Removal is a status change plus a moderator, time and
reason; the author's text is retained in the row and simply not returned to the browser.

### Stretch (T4)

**`issued_records`** — signed participation records with their payload, signature and `key_id`, so a
record remains verifiable after a key rotation reveals which key signed it.

**`api_keys`** — hashed like sessions; a key carries no powers of its own, only its owner's.

**`webhooks` / `webhook_deliveries`** — endpoint, signing secret, topic filter, plus per-delivery
status, attempt count and last error, so failures are visible without reading a log file.

### Audit

**`audit_events`** — append-only. Never updated or deleted by the application.
`actor_label` is denormalised (`Name <email>`) so the trail stays readable after
an account is removed. `outcome` is `ok` or `denied`, so refused access attempts
are recorded alongside successful actions.

### Governance

**`role_invitations`** — a single-person role grant, deliberately separate from
the reusable team link in `invitations`. Carries the event, the role, the track
scope, an optional `email_ci` that restricts who may accept, an expiry and a
one-use `accepted_at`. The scope granted at acceptance is read from this row,
so nothing the browser sends can widen it.

**`eligibility_decisions`** — append-only. Each row is one organizer decision
(`disqualified` or `reinstated`) with its reason, actor and time. The current
answer is denormalised onto `projects.disqualified_at` so every "still in the
running" query can filter on one indexed column; the history explains it.

**`team_member_history`** — written when somebody leaves a team. Judging
conflicts are decided from current membership **or** this table, so leaving a
team cannot turn a conflicted judge into an eligible one.

## State machines

### Event

```
draft ──▶ open ──▶ submissions_closed ──▶ judging ──▶ results_published
  │         │            │  ▲                │  ▲            │
  │         │            └──┘ (reopen)       └──┘ (pause)    │ (unpublish)
  │         │                                      ▲─────────┘
  └─────────┴──────────────────────────────────────┴──▶ archived
```

Transitions are validated by `canTransition()` against an explicit table.
`draft → results_published` is refused. `archived` is terminal.

### Project

`draft → submitted` (validated, snapshotted) · `draft|submitted → withdrawn`.
Editing after submit is allowed until the deadline and appends a revision.

### Assignment / Review

`pending → in_progress → submitted`, plus `revoked` from any state by an
organizer. The review's own status is `draft → submitted`; submitting is
one-way for a judge, reversible only by an organizer.

### Result snapshot

`computed → published → superseded`. Only one `published` per event.

## Integrity constraints that matter

| Constraint | Prevents |
|---|---|
| `UNIQUE(projects.team_id)` | A team fielding two entries |
| `UNIQUE(assignments.project_id, judge_user_id)` | Double-assigning a judge |
| `UNIQUE(reviews.assignment_id)` | Two ballots for one assignment |
| `UNIQUE(criterion_scores.review_id, criterion_id)` | Duplicate criterion scores |
| `UNIQUE(sessions.token_hash)`, `UNIQUE(invitations.token_hash)` | Token collision |
| `UNIQUE(users.email_ci)` | Case-variant duplicate accounts |
| `CHECK(status IN (...))` on every status column | Invalid states |
| `CHECK(criteria.scale_max > scale_min)` | A scale with no range |
| Conflict-of-interest check in `authz.ts` | A judge reviewing their own team |

## Getting data out

CSV from the organizer console, or `GET /api/events/:slug/export/:name`
(same authorization as the pages — organizer only):

`projects` · `teams` · `judges` · `assignments` · `reviews` ·
`criterion-scores` · `results` · `audit`

RFC 4180: CRLF endings, every value quoted, embedded quotes doubled. Values
beginning `=`, `+`, `-` or `@` are prefixed with a single quote so a spreadsheet
does not evaluate them as formulas — a real risk when project descriptions are
attacker-controlled. Column headers are declared per export, so an export with
no rows is still a valid, self-describing file.

`criterion-scores.csv` plus `reviews.csv` contain everything needed to
independently recompute a published ranking.

## Getting data in

A whole event moves as one JSON bundle (`forgeboard.bundle/1`): an organizer exports it from
`GET /api/v1/events/:slug/export` and imports it with `POST /api/v1/events/:slug/import`. A dry run
(`"dry_run": true`) validates every reference, score and criterion and writes nothing; a real import
recomputes weighted scores from the criterion scores rather than trusting the file, and imported
accounts cannot be signed into. The fixtures are loaded by `scripts/seed-fixtures.ts`.

## Backup and recovery

The entire instance is two paths on the volume:

```
/data/forgeboard.db     the database (plus -wal and -shm while running)
/data/uploads/          media, when upload is enabled
```

Back up with SQLite's own consistent-copy command rather than `cp`, which can
catch a torn WAL:

```bash
sqlite3 /data/forgeboard.db ".backup '/backup/forgeboard-$(date +%F).db'"
```

Restore by stopping the container, replacing the file, and starting it.

**Schema upgrades.** `migrate()` applies `schema.sql`, where every statement is
`CREATE ... IF NOT EXISTS`, and then adds any column an older database is
missing (`ADDED_COLUMNS` in `lib/db/client.ts`, checked against
`PRAGMA table_info`). Both halves are idempotent and additive: nothing drops or
rewrites a column, so a restored older file is brought up to schema at startup
without losing anything. A destructive change would need a real migration step;
there has not been one.

**Account recovery.** There is no email, so recovery is a link somebody hands
over. An instance admin issues one from `/admin`; it is shown once, works once,
expires in an hour, and signs the account out of every session when redeemed.

If nobody can sign in at all, the operator issues one from the server:

```bash
npm run user:reset -- you@example.org
# in Docker:
docker compose exec forgeboard node scripts/reset-password.ts you@example.org
```

That prints a one-use link and records the issue in the audit trail. Whoever can
run it already has the database in their hands, so it grants nothing they could
not take anyway — it is simply the safe, recorded way to give access back.

As a last resort, the database can be edited directly, or deleted so that the
first account registered on the fresh instance becomes the admin:

```bash
sqlite3 /data/forgeboard.db "UPDATE users SET global_role='admin' WHERE email_ci='you@example.org';"
```

## If you outgrow SQLite

The schema is deliberately portable. Moving to Postgres means:

1. `TEXT` ids, `TEXT` timestamps and `REAL` scores all map directly.
2. Replace `INTEGER` booleans with `BOOLEAN`, or keep the `CHECK`.
3. `IFNULL` → `COALESCE`; the partial-unique-index trick becomes
   `CREATE UNIQUE INDEX ... ON event_roles (event_id, user_id, role, COALESCE(track_id, ''))`.
4. `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; the upserts are already
   `ON CONFLICT ... DO UPDATE` and port unchanged.
5. Swap `lib/db/client.ts` for a `pg` pool and make the call sites `await`.

The domain layer never touches the driver directly, so that is the only file
with dialect knowledge — plus the `IFNULL` occurrences, which `grep` finds.
