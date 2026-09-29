-- Forgeboard schema, version 2: evidence a reader can check without trusting the server.
--
--   * audit_log.hash chains every entry to the one before it: hash = SHA-256 of the previous
--     hash and the entry's own fields (see src/domain/audit.ts). The triggers from version 1
--     already refuse UPDATE and DELETE through SQL; the chain also exposes an edit made to the
--     database file directly, because every later hash stops matching. Entries written before
--     this migration have no hash and are reported as unchained, never silently accepted.
--   * result_rows keep the 90% rank interval and the prize-place share that were shown when
--     the snapshot was published.
--   * result_snapshots keep the exact signed document (canonical JSON), its Ed25519 signature,
--     the public key and the model's inputs (one weighted score per review, judges
--     pseudonymized), so a published ranking can be verified and refitted offline, years later.

ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN hash TEXT;

ALTER TABLE result_rows ADD COLUMN rank_lo INTEGER;
ALTER TABLE result_rows ADD COLUMN rank_hi INTEGER;
ALTER TABLE result_rows ADD COLUMN podium_share REAL;

ALTER TABLE result_snapshots ADD COLUMN document TEXT CHECK (document IS NULL OR json_valid(document));
ALTER TABLE result_snapshots ADD COLUMN signature TEXT;
ALTER TABLE result_snapshots ADD COLUMN public_key TEXT;
ALTER TABLE result_snapshots ADD COLUMN inputs TEXT CHECK (inputs IS NULL OR json_valid(inputs));
