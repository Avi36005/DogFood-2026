-- Forgeboard schema, version 3: the public tier (T3). Community voting and comments.
--
--   * One vote_settings row per event that runs a community vote: the window, who may vote,
--     how many projects a ballot may approve, and when the organizer revealed the tally.
--   * Voters are either accounts or holders of a one-time code the organizer printed for the
--     venue. Codes are stored only as hashes, like every other token here.
--   * One ballot per account per event and one ballot per code, enforced by unique indexes, so
--     a double-submitted form or a replayed request cannot count twice.
--   * A ballot stores keyed hashes of the voter's IP and user agent (HMAC with the instance
--     secret), enough to show an organizer a cluster of ballots from one address without
--     keeping the address itself on the ballot.
--   * Nothing is deleted. A ballot an organizer rejects is voided with a reason; a comment an
--     organizer takes down is hidden with a reason. Both stay on record and on the audit trail.

CREATE TABLE vote_settings (
  event_id     TEXT PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  opens_at     TEXT NOT NULL,
  closes_at    TEXT NOT NULL,
  access       TEXT NOT NULL CHECK (access IN ('accounts', 'codes')),
  max_picks    INTEGER NOT NULL CHECK (max_picks BETWEEN 1 AND 10),
  published_at TEXT,
  updated_at   TEXT NOT NULL,
  CHECK (closes_at > opens_at)
);

CREATE TABLE voter_codes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  batch      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX voter_codes_by_event ON voter_codes (event_id, batch);

CREATE TABLE ballots (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  voter_user_id TEXT REFERENCES users (id),
  voter_code_id TEXT REFERENCES voter_codes (id),
  cast_at       TEXT NOT NULL,
  ip_hash       TEXT,
  ua_hash       TEXT,
  voided_at     TEXT,
  voided_reason TEXT,
  CHECK ((voter_user_id IS NULL) <> (voter_code_id IS NULL)),
  CHECK ((voided_at IS NULL) = (voided_reason IS NULL))
);
CREATE UNIQUE INDEX ballots_one_per_account ON ballots (event_id, voter_user_id) WHERE voter_user_id IS NOT NULL;
CREATE UNIQUE INDEX ballots_one_per_code ON ballots (voter_code_id) WHERE voter_code_id IS NOT NULL;
CREATE INDEX ballots_by_address ON ballots (event_id, ip_hash);

CREATE TABLE ballot_picks (
  ballot_id  TEXT NOT NULL REFERENCES ballots (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  PRIMARY KEY (ballot_id, project_id)
);

-- A cast ballot is final: its picks cannot change, only the whole ballot can be voided.
CREATE TRIGGER ballot_picks_no_update BEFORE UPDATE ON ballot_picks
BEGIN SELECT RAISE(ABORT, 'ballot picks are final'); END;
CREATE TRIGGER ballot_picks_no_delete BEFORE DELETE ON ballot_picks
BEGIN SELECT RAISE(ABORT, 'ballot picks are final'); END;

CREATE TABLE comments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users (id),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at    TEXT NOT NULL,
  hidden_at     TEXT,
  hidden_by     TEXT REFERENCES users (id),
  hidden_reason TEXT,
  CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL))
);
CREATE INDEX comments_by_project ON comments (project_id, created_at);
