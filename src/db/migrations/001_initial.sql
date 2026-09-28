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

