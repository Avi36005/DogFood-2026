-- Forgeboard schema, version 4: compare mode (pairwise judging).
--
-- A judge shown two of their own assigned projects records which is better. One choice per
-- judge per pair (an expression index over the unordered pair), final once made (triggers).
-- The choices feed a Bradley–Terry fit shown beside the rubric ranking; see src/domain/pairwise.ts.

CREATE TABLE pairwise_votes (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id),
  judge_id   TEXT NOT NULL REFERENCES users (id),
  winner_id  TEXT NOT NULL REFERENCES projects (id),
  loser_id   TEXT NOT NULL REFERENCES projects (id),
  created_at TEXT NOT NULL,
  CHECK (winner_id <> loser_id)
);
CREATE UNIQUE INDEX pairwise_once_per_judge ON pairwise_votes (event_id, judge_id, min(winner_id, loser_id), max(winner_id, loser_id));
CREATE INDEX pairwise_by_event ON pairwise_votes (event_id);

CREATE TRIGGER pairwise_votes_no_update BEFORE UPDATE ON pairwise_votes
BEGIN SELECT RAISE(ABORT, 'pairwise choices are final'); END;
CREATE TRIGGER pairwise_votes_no_delete BEFORE DELETE ON pairwise_votes
BEGIN SELECT RAISE(ABORT, 'pairwise choices are final'); END;
