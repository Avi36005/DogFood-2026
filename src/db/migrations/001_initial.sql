-- Forgeboard schema, version 1.
--
-- Conventions
--   * Ids are opaque TEXT. Rows imported from fixtures.json keep their fixture ids
--     (evt_01, prj_07, jdg_24) so every number can be traced back to the input file.
--   * Timestamps are UTC ISO 8601 strings (2026-03-01T18:00:00.000Z), which sort correctly as text.
--   * Every row that belongs to an event carries event_id, and composite foreign keys make
--     it impossible to point a project at another event's track, or a judge at another
--     event's project.
--   * Raw data is never overwritten by derived data. Normalized results live in snapshots.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Identity -------------------------------------------------------------------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email LIKE '%_@_%'),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  password_hash TEXT,                -- NULL until the person sets one through a one-time link
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,        -- sha256 of the cookie value; the cookie itself is never stored
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  is_demo    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
);
CREATE INDEX sessions_by_user ON sessions (user_id);

-- One-time links to set a password: invited judges, imported people, account recovery.
CREATE TABLE password_links (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('setup', 'reset')),
  created_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Events ---------------------------------------------------------------------

CREATE TABLE events (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE CHECK (slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'),
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  tagline              TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 200),
  description          TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  submissions_open_at  TEXT,          -- NULL: accepting drafts as soon as the event exists
  submissions_close_at TEXT NOT NULL, -- the deadline; enforced on every write, server clock
  judging_close_at     TEXT,          -- NULL: judging stays open until results are published
  results_published_at TEXT,
  max_team_size        INTEGER NOT NULL DEFAULT 4 CHECK (max_team_size BETWEEN 1 AND 20),
  reviews_per_project  INTEGER NOT NULL DEFAULT 3 CHECK (reviews_per_project BETWEEN 1 AND 20),
  score_min            INTEGER NOT NULL DEFAULT 1,
  score_max            INTEGER NOT NULL DEFAULT 5,
  source               TEXT NOT NULL DEFAULT 'created' CHECK (source IN ('created', 'fixture')),
  created_by           TEXT REFERENCES users (id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (score_min >= 0 AND score_max <= 100 AND score_min < score_max),
  CHECK (submissions_open_at IS NULL OR submissions_open_at < submissions_close_at)
);

-- Roles are per event. "visitor" is the absence of a row; "admin" is users.is_admin.
CREATE TABLE event_roles (
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('organizer', 'judge', 'participant')),
  granted_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id, role)
);
CREATE INDEX event_roles_by_user ON event_roles (user_id);

CREATE TABLE tracks (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name),
  UNIQUE (id, event_id)
);

CREATE TABLE prizes (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  track_id    TEXT,                   -- NULL: an event-wide prize
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  position    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (track_id, event_id) REFERENCES tracks (id, event_id)
);

-- Teams ----------------------------------------------------------------------

-- Team names are not unique: the fixtures hold three pairs of different teams that share a
-- name. New teams created in the portal are asked to pick an unused name (teams.ts).
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name       TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 80),
  created_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  UNIQUE (id, event_id)
);
CREATE INDEX teams_by_event ON teams (event_id, name);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_captain INTEGER NOT NULL DEFAULT 0 CHECK (is_captain IN (0, 1)),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id),
  UNIQUE (event_id, user_id),         -- one team per person per event
  FOREIGN KEY (team_id, event_id) REFERENCES teams (id, event_id) ON DELETE CASCADE
);

-- Invite links are multi-use until they expire, are replaced, or the team is full.
CREATE TABLE team_invites (
  token_hash TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX team_invites_by_team ON team_invites (team_id);

-- Projects -------------------------------------------------------------------

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  track_id      TEXT,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary       TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 280),
  description   TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  repo_url      TEXT NOT NULL DEFAULT '' CHECK (length(repo_url) <= 500),
  demo_url      TEXT NOT NULL DEFAULT '' CHECK (length(demo_url) <= 500),
  video_url     TEXT NOT NULL DEFAULT '' CHECK (length(video_url) <= 500),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'withdrawn')),
  submitted_at  TEXT,
  -- A later submission from the same team replaces this one. Both rows are kept.
  superseded_by TEXT REFERENCES projects (id) DEFERRABLE INITIALLY DEFERRED,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (id, event_id),
  FOREIGN KEY (team_id, event_id) REFERENCES teams (id, event_id),
  FOREIGN KEY (track_id, event_id) REFERENCES tracks (id, event_id),
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL),
  CHECK (superseded_by IS NULL OR superseded_by <> id)
);
-- One live project per team: the rule that turns the fixture's duplicate into an explicit decision.
CREATE UNIQUE INDEX projects_one_live_per_team ON projects (team_id)
  WHERE superseded_by IS NULL AND status <> 'withdrawn';
CREATE INDEX projects_by_event ON projects (event_id, status);

-- Append-only history: answers "what did this team have at the deadline?"
CREATE TABLE project_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects (id),
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('imported', 'created', 'edited', 'submitted', 'withdrawn', 'superseded', 'restored')),
  snapshot   TEXT NOT NULL CHECK (json_valid(snapshot)),
  actor_id   TEXT,
  at         TEXT NOT NULL,
  UNIQUE (project_id, version)
);

-- Judging --------------------------------------------------------------------

CREATE TABLE criteria (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  key         TEXT NOT NULL CHECK (key <> '' AND key NOT GLOB '*[^a-z0-9_]*'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  weight      REAL NOT NULL CHECK (weight > 0 AND weight <= 100),
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, key),
  UNIQUE (id, event_id)
);

-- Which tracks a judge covers. The judge_role column lets the foreign key require that the
-- person actually holds the judge role, and removing the role removes the grants.
CREATE TABLE judge_tracks (
  event_id   TEXT NOT NULL,
  judge_id   TEXT NOT NULL,
  judge_role TEXT NOT NULL DEFAULT 'judge' CHECK (judge_role = 'judge'),
  track_id   TEXT NOT NULL,
  PRIMARY KEY (event_id, judge_id, track_id),
  FOREIGN KEY (event_id, judge_id, judge_role) REFERENCES event_roles (event_id, user_id, role) ON DELETE CASCADE,
  FOREIGN KEY (track_id, event_id) REFERENCES tracks (id, event_id) ON DELETE CASCADE
);

-- The judge is created (without a password) when invited; the link lets them claim the account.
CREATE TABLE judge_invites (
  token_hash  TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE assignments (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  project_id TEXT NOT NULL,
  judge_id   TEXT NOT NULL,
  judge_role TEXT NOT NULL DEFAULT 'judge' CHECK (judge_role = 'judge'),
  source     TEXT NOT NULL CHECK (source IN ('fixture', 'auto', 'manual')),
  created_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, judge_id),
  UNIQUE (id, event_id),
  FOREIGN KEY (project_id, event_id) REFERENCES projects (id, event_id),
  -- No cascade: a judge with reviews on record cannot be silently removed.
  FOREIGN KEY (event_id, judge_id, judge_role) REFERENCES event_roles (event_id, user_id, role)
);
CREATE INDEX assignments_by_judge ON assignments (judge_id, event_id);
CREATE INDEX assignments_by_event ON assignments (event_id);

CREATE TABLE reviews (
  assignment_id TEXT PRIMARY KEY REFERENCES assignments (id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
  comment       TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 5000),
  submitted_at  TEXT,
  updated_at    TEXT NOT NULL,
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);

CREATE TABLE review_scores (
  assignment_id TEXT NOT NULL REFERENCES reviews (assignment_id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL REFERENCES criteria (id),
  value         INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, criterion_id)
);

