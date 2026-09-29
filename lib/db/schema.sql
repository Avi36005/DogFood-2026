-- Forgeboard schema. SQLite (STRICT tables), applied by scripts/migrate.ts.
-- All timestamps are UTC ISO-8601 strings ('YYYY-MM-DDTHH:MM:SS.sssZ').
-- Display timezone is a per-event presentation concern (events.timezone).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_ci      TEXT NOT NULL,                  -- lowercased, uniqueness key
  password_hash TEXT NOT NULL,                  -- scrypt, hex
  password_salt TEXT NOT NULL,                  -- hex
  display_name  TEXT NOT NULL,
  global_role   TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  disabled_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (global_role IN ('admin','user')),
  CHECK (length(display_name) BETWEEN 1 AND 80)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_ci ON users(email_ci);

-- Sessions are server-side. The cookie carries an opaque token; only its
-- SHA-256 is stored, so a database leak does not yield usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- Instance-wide settings. Key/value so a new policy does not need a migration.
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
) STRICT;

-- ------------------------------------------------------------------ events --

CREATE TABLE IF NOT EXISTS events (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  tagline              TEXT NOT NULL DEFAULT '',
  description          TEXT NOT NULL DEFAULT '',
  timezone             TEXT NOT NULL DEFAULT 'UTC',
  status               TEXT NOT NULL DEFAULT 'draft',
  submissions_open_at  TEXT,
  submissions_close_at TEXT,
  judging_open_at      TEXT,
  judging_close_at     TEXT,
  results_published_at TEXT,
  reviews_per_project  INTEGER NOT NULL DEFAULT 3,
  max_team_size        INTEGER NOT NULL DEFAULT 4,
  voting_enabled       INTEGER NOT NULL DEFAULT 0,
  voting_mode          TEXT NOT NULL DEFAULT 'authenticated',
  voting_open_at       TEXT,
  voting_close_at      TEXT,
  votes_per_voter      INTEGER NOT NULL DEFAULT 3,
  voting_results_public INTEGER NOT NULL DEFAULT 0,
  comments_enabled     INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency
  CHECK (status IN ('draft','open','submissions_closed','judging','results_published','archived')),
  CHECK (reviews_per_project BETWEEN 1 AND 20),
  CHECK (max_team_size BETWEEN 1 AND 50),
  CHECK (voting_mode IN ('open_link','email_gated','authenticated')),
  CHECK (voting_enabled IN (0,1)),
  CHECK (comments_enabled IN (0,1)),
  CHECK (voting_results_public IN (0,1)),
  CHECK (votes_per_voter BETWEEN 1 AND 100)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_slug ON events(slug);

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tracks_event_slug ON tracks(event_id, slug);

CREATE TABLE IF NOT EXISTS prizes (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  track_id    TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_text TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_prizes_event ON prizes(event_id);

CREATE TABLE IF NOT EXISTS custom_questions (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  prompt       TEXT NOT NULL,
  help_text    TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'short_text',
  required     INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '[]',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- Answers are private to the team, organizers and assigned judges unless the
  -- organizer marks the question public. Nothing private reaches the gallery.
  is_public    INTEGER NOT NULL DEFAULT 0,
  CHECK (kind IN ('short_text','long_text','url','single_select','multi_select')),
  CHECK (required IN (0,1)),
  CHECK (is_public IN (0,1))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_questions_event ON custom_questions(event_id);

-- Event-scoped authorization. A user's powers are (event, role[, track]).
-- A judge row with track_id IS NULL judges every track; with a track_id it is
-- restricted to that track and the backend filters on it.
CREATE TABLE IF NOT EXISTS event_roles (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  track_id   TEXT REFERENCES tracks(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (role IN ('participant','judge','organizer'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_event_roles
  ON event_roles(event_id, user_id, role, IFNULL(track_id,''));
CREATE INDEX IF NOT EXISTS ix_event_roles_lookup ON event_roles(event_id, user_id);

-- ------------------------------------------------------------------- teams --

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 80)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_teams_event_name ON teams(event_id, name);

CREATE TABLE IF NOT EXISTS team_members (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  CHECK (role IN ('owner','member'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_team_members ON team_members(team_id, user_id);
-- One team per user per event, enforced by index rather than by trust.
CREATE INDEX IF NOT EXISTS ix_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  max_uses   INTEGER NOT NULL DEFAULT 4,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invitations_token ON invitations(token_hash);

-- ------------------------------------------------------------- submissions --

CREATE TABLE IF NOT EXISTS media_assets (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,     -- relative to FORGEBOARD_UPLOAD_DIR
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  track_id           TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  name               TEXT NOT NULL DEFAULT '',
  tagline            TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  thumbnail_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  demo_video_url     TEXT NOT NULL DEFAULT '',
  repo_url           TEXT NOT NULL DEFAULT '',
  live_url           TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'draft',
  submitted_at       TEXT,
  withdrawn_at       TEXT,
  -- Set by an organizer's eligibility decision; history is in eligibility_decisions.
  disqualified_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  CHECK (status IN ('draft','submitted','withdrawn'))
) STRICT;
-- One project per team. The gallery, assignment and scoring all assume this.
CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_team ON projects(team_id);
CREATE INDEX IF NOT EXISTS ix_projects_event_status ON projects(event_id, status);
CREATE INDEX IF NOT EXISTS ix_projects_track ON projects(track_id);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (project_id, tag)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_project_tags_tag ON project_tags(tag);

CREATE TABLE IF NOT EXISTS project_media (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_media ON project_media(project_id, asset_id);

CREATE TABLE IF NOT EXISTS custom_answers (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES custom_questions(id) ON DELETE CASCADE,
  value_text  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_custom_answers ON custom_answers(project_id, question_id);

-- Immutable submission history. A row is appended on every submit, so an
-- organizer can always show what was on record at the deadline.
CREATE TABLE IF NOT EXISTS submission_revisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_revisions ON submission_revisions(project_id, revision);

-- ----------------------------------------------------------------- judging --

CREATE TABLE IF NOT EXISTS rubric_versions (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  name         TEXT NOT NULL DEFAULT 'Rubric',
  status       TEXT NOT NULL DEFAULT 'draft',
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  published_at TEXT,
  CHECK (status IN ('draft','published','superseded'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_rubric_version ON rubric_versions(event_id, version);

CREATE TABLE IF NOT EXISTS criteria (
  id                TEXT PRIMARY KEY,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  weight            REAL NOT NULL DEFAULT 1,
  scale_min         INTEGER NOT NULL DEFAULT 1,
  scale_max         INTEGER NOT NULL DEFAULT 5,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  CHECK (weight >= 0),
  CHECK (scale_max > scale_min)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_criteria_rubric ON criteria(rubric_version_id);

CREATE TABLE IF NOT EXISTS assignments (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  judge_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  batch_label   TEXT NOT NULL DEFAULT '',
  assigned_by   TEXT REFERENCES users(id),
  assigned_at   TEXT NOT NULL,
  revoked_at    TEXT,
  CHECK (status IN ('pending','in_progress','submitted','revoked'))
) STRICT;
-- A judge is assigned a project at most once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_assignments ON assignments(project_id, judge_user_id);
CREATE INDEX IF NOT EXISTS ix_assignments_judge ON assignments(judge_user_id, status);
CREATE INDEX IF NOT EXISTS ix_assignments_event ON assignments(event_id, status);

CREATE TABLE IF NOT EXISTS reviews (
  id                TEXT PRIMARY KEY,
  assignment_id     TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  status            TEXT NOT NULL DEFAULT 'draft',
  overall_comment   TEXT NOT NULL DEFAULT '',
  raw_weighted      REAL,               -- cached Σ(w·s)/Σw at submit time
  raw_weighted_100  REAL,               -- same review mapped to 0-100
  complete          INTEGER NOT NULL DEFAULT 0,  -- every criterion scored
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  submitted_at      TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  CHECK (status IN ('draft','submitted'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_reviews_assignment ON reviews(assignment_id);

CREATE TABLE IF NOT EXISTS criterion_scores (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  score        REAL NOT NULL,
  comment      TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_criterion_scores ON criterion_scores(review_id, criterion_id);

-- ----------------------------------------------------------------- results --

CREATE TABLE IF NOT EXISTS result_snapshots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  algorithm   TEXT NOT NULL,          -- 'raw_weighted_mean' | 'shrunk_zscore'
  params_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'computed',
  method          TEXT NOT NULL DEFAULT '',
  method_version  TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'standardized',
  rubric_version_id TEXT REFERENCES rubric_versions(id),
  warnings_json   TEXT NOT NULL DEFAULT '[]',
  computed_by TEXT NOT NULL REFERENCES users(id),
  computed_at TEXT NOT NULL,
  published_at TEXT,
  CHECK (status IN ('computed','published','superseded'))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_snapshots_event ON result_snapshots(event_id, status);

CREATE TABLE IF NOT EXISTS result_rows (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL REFERENCES result_snapshots(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_id        TEXT,
  rank            INTEGER,
  rank_in_track   INTEGER,
  raw_mean        REAL,
  raw_mean_100    REAL,
  mean_z          REAL,
  normalized_mean REAL,
  reviews_counted INTEGER NOT NULL DEFAULT 0,
  usable_reviews  INTEGER NOT NULL DEFAULT 0,
  sufficient      INTEGER NOT NULL DEFAULT 1,
  raw_rank        INTEGER,
  rank_delta      INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_result_rows ON result_rows(snapshot_id, project_id);

-- ------------------------------------------------------------------- audit --

CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  event_id       TEXT REFERENCES events(id) ON DELETE SET NULL,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label    TEXT NOT NULL DEFAULT '',   -- denormalised, survives user delete
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL DEFAULT '',
  subject_id     TEXT NOT NULL DEFAULT '',
  detail_json    TEXT NOT NULL DEFAULT '{}',
  outcome        TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'denied'
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_audit_event ON audit_events(event_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_events(actor_user_id, created_at);

-- ------------------------------------------------------------ T3: voting --

-- One row per distinguishable voter within one event. `kind` records how much
-- the identity is actually worth: a cookie is not a person.
CREATE TABLE IF NOT EXISTS voters (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,              -- 'session' | 'email' | 'account'
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_ci        TEXT,
  session_hash    TEXT,                       -- SHA-256 of the voter cookie
  verified_at     TEXT,
  ip_hash         TEXT,                       -- salted, for abuse signals only
  created_at      TEXT NOT NULL,
  blocked_at      TEXT,
  blocked_reason  TEXT NOT NULL DEFAULT '',
  CHECK (kind IN ('session','email','account'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_voters_account ON voters(event_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_voters_email ON voters(event_id, email_ci) WHERE email_ci IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_voters_session ON voters(event_id, session_hash) WHERE session_hash IS NOT NULL;

-- Expiring, single-use possession tokens for the email-gated mode. Delivery is
-- the operator's own channel; Forgeboard never sends mail.
CREATE TABLE IF NOT EXISTS vote_tokens (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email_ci   TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_vote_tokens ON vote_tokens(token_hash);
CREATE INDEX IF NOT EXISTS ix_vote_tokens_email ON vote_tokens(event_id, email_ci);

CREATE TABLE IF NOT EXISTS votes (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  voter_id           TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  retracted_at       TEXT,
  invalidated_at     TEXT,
  invalidated_by     TEXT REFERENCES users(id),
  invalidated_reason TEXT NOT NULL DEFAULT ''
) STRICT;
-- One live vote per voter per project. Retracted and invalidated rows are kept
-- for the audit trail but leave the uniqueness slot free.
CREATE UNIQUE INDEX IF NOT EXISTS ux_votes_live
  ON votes(project_id, voter_id) WHERE retracted_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_votes_event ON votes(event_id, created_at);

-- ---------------------------------------------------------- T3: comments --

CREATE TABLE IF NOT EXISTS comments (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'visible',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  moderated_by      TEXT REFERENCES users(id),
  moderated_at      TEXT,
  moderation_reason TEXT NOT NULL DEFAULT '',
  CHECK (status IN ('visible','removed'))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_comments_project ON comments(project_id, created_at);

-- ------------------------------------------------- T4: issued records -----

CREATE TABLE IF NOT EXISTS issued_records (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json    TEXT NOT NULL,
  signature       TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  issued_by       TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS ix_records_event ON issued_records(event_id, created_at);
CREATE INDEX IF NOT EXISTS ix_records_subject ON issued_records(subject_user_id);

-- ------------------------------------------------- T4: API and webhooks ---

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT 'read',   -- 'read' | 'read,write'
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_keys ON api_keys(token_hash);

CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  topics      TEXT NOT NULL DEFAULT '*',
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  last_status TEXT NOT NULL DEFAULT '',
  failures    INTEGER NOT NULL DEFAULT 0,
  CHECK (active IN (0,1))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_webhooks_event ON webhooks(event_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  delivery_id  TEXT NOT NULL,
  topic        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  CHECK (status IN ('pending','delivered','failed','blocked'))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);

-- ------------------------------------------------- history and recovery ----

-- Past team membership. A judge who leaves a team keeps the conflict of
-- interest they had while on it, so leaving cannot be used to become eligible.
CREATE TABLE IF NOT EXISTS team_member_history (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  left_at   TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT 'left'
) STRICT;
CREATE INDEX IF NOT EXISTS ix_team_member_history ON team_member_history(team_id, user_id);

-- A single-person role invitation, unlike the reusable team join link in
-- `invitations`: one named account, one use, an expiry, and a track scope that
-- the browser cannot widen because it is read from this row at acceptance.
CREATE TABLE IF NOT EXISTS role_invitations (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'judge',
  track_id    TEXT REFERENCES tracks(id) ON DELETE CASCADE,
  email_ci    TEXT NOT NULL DEFAULT '',          -- '' = any signed-in account may accept
  note        TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  revoked_at  TEXT,
  CHECK (role IN ('judge'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_invitations_token ON role_invitations(token_hash);
CREATE INDEX IF NOT EXISTS ix_role_invitations_event ON role_invitations(event_id, created_at);

-- Append-only eligibility decisions. The newest row per project is in force,
-- and projects.disqualified_at carries the same answer for fast filtering.
CREATE TABLE IF NOT EXISTS eligibility_decisions (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  decided_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL,
  CHECK (decision IN ('disqualified','reinstated'))
) STRICT;
CREATE INDEX IF NOT EXISTS ix_eligibility_project ON eligibility_decisions(project_id, decided_at);

-- Local password recovery. One use, one hour, hash only, and every issue and
-- redemption is audited. There is no email here: an admin or the operator at
-- the command line hands the link over through their own channel.
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),          -- NULL when issued from the CLI
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_password_resets_token ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS ix_password_resets_user ON password_resets(user_id, created_at);
