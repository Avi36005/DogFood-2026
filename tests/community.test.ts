/** T3 behaviour: voting, comments, moderation. Internal ids, not official ones. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "forgeboard-t3-"));
process.env.FORGEBOARD_DB_PATH = path.join(dir, "test.db");
process.env.FORGEBOARD_UPLOAD_DIR = path.join(dir, "uploads");
execFileSync(process.execPath, ["scripts/seed.ts"], { env: process.env, stdio: "pipe", cwd: process.cwd() });

const { get, all, run, nowIso } = await import("../lib/db/client.ts");
const { capabilityFor, AccessDenied } = await import("../lib/authz.ts");
const accounts = await import("../lib/domain/accounts.ts");
const events = await import("../lib/domain/events.ts");
const voting = await import("../lib/domain/voting.ts");
const comments = await import("../lib/domain/comments.ts");

const eventId = get<{ id: string }>(`SELECT id FROM events WHERE slug = 'autumn-build-2026'`)!.id;
const organizer = accounts.toActor(accounts.byEmail("organizer@forgeboard.local")!);
const participant = accounts.toActor(accounts.byEmail("participant@forgeboard.local")!);
const orgCap = capabilityFor(organizer, eventId);
const partCap = capabilityFor(participant, eventId);

function configureVoting(patch: Record<string, unknown>) {
  const fields = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
  run(`UPDATE events SET ${fields} WHERE id = ?`, ...Object.values(patch), eventId);
  return events.byId(eventId)!;
}

const projectIds = all<{ id: string }>(
  `SELECT id FROM projects WHERE event_id = ? AND status = 'submitted' ORDER BY id`, eventId,
).map((r) => r.id);

let cookieSeq = 0;
function newVoter(mode: "open_link" | "authenticated" = "open_link", actor = participant) {
  const event = events.byId(eventId)!;
  const cookie = `cookie-${++cookieSeq}-${Math.random()}`;
  const { voter } = voting.resolveVoter(event, {
    actor: mode === "authenticated" ? actor : null,
    voterCookie: mode === "authenticated" ? null : cookie,
    ip: "203.0.113.5",
  });
  return voter!;
}

describe("VOTE-03 window enforcement", () => {
  test("votes before the window opens are refused", () => {
    const e = configureVoting({
      voting_enabled: 1, voting_mode: "open_link", votes_per_voter: 3,
      voting_open_at: new Date(Date.now() + 3600e3).toISOString(),
      voting_close_at: new Date(Date.now() + 7200e3).toISOString(),
    });
    assert.equal(voting.votingState(e), "not_started");
    const voter = newVoter();
    assert.throws(() => voting.castVote(e, voter, projectIds[0], null), /not open/i);
  });

  test("votes after the window closes are refused", () => {
    const e = configureVoting({
      voting_open_at: new Date(Date.now() - 7200e3).toISOString(),
      voting_close_at: new Date(Date.now() - 3600e3).toISOString(),
    });
    assert.equal(voting.votingState(e), "closed");
    const voter = newVoter();
    assert.throws(() => voting.castVote(e, voter, projectIds[0], null), /not open/i);
  });
});

describe("VOTE-01/02 correctness and budget", () => {
  test("an eligible voter can vote, and a repeat is idempotent rather than double-spent", () => {
    const e = configureVoting({
      voting_open_at: new Date(Date.now() - 3600e3).toISOString(),
      voting_close_at: new Date(Date.now() + 3600e3).toISOString(),
    });
    const voter = newVoter();
    assert.equal(voting.castVote(e, voter, projectIds[0], null), "created");
    assert.equal(voting.castVote(e, voter, projectIds[0], null), "already_counted");
    assert.equal(voting.liveVotesFor(voter.id).length, 1);
    assert.equal(voting.remainingBudget(e, voter.id), 2);
  });

  test("the budget is enforced and cannot be exceeded", () => {
    const e = events.byId(eventId)!;
    const voter = newVoter();
    for (let i = 0; i < e.votes_per_voter; i++) voting.castVote(e, voter, projectIds[i], null);
    assert.equal(voting.remainingBudget(e, voter.id), 0);
    assert.throws(() => voting.castVote(e, voter, projectIds[e.votes_per_voter], null), /used all/i);
  });

  test("a database index, not a check, prevents a duplicate live vote", () => {
    const e = events.byId(eventId)!;
    const voter = newVoter();
    voting.castVote(e, voter, projectIds[0], null);
    assert.throws(
      () => run(`INSERT INTO votes (id, event_id, project_id, voter_id, created_at) VALUES (?,?,?,?,?)`,
        "vot_forced", e.id, projectIds[0], voter.id, nowIso()),
      /UNIQUE|constraint/i,
    );
  });

  test("retracting frees the budget and is safe to repeat", () => {
    const e = events.byId(eventId)!;
    const voter = newVoter();
    voting.castVote(e, voter, projectIds[0], null);
    assert.equal(voting.retractVote(e, voter, projectIds[0]), "retracted");
    assert.equal(voting.retractVote(e, voter, projectIds[0]), "already_counted");
    assert.equal(voting.remainingBudget(e, voter.id), e.votes_per_voter);
    // The retracted row is kept for the audit trail.
    assert.ok(all(`SELECT id FROM votes WHERE voter_id = ? AND retracted_at IS NOT NULL`, voter.id).length > 0);
  });

  test("a draft or withdrawn project cannot be voted on", () => {
    const e = events.byId(eventId)!;
    const draft = get<{ id: string }>(
      `SELECT id FROM projects WHERE event_id = ? AND status != 'submitted' LIMIT 1`, eventId)!;
    assert.throws(() => voting.castVote(e, newVoter(), draft.id, null), /not eligible|not in this event/i);
  });
});

describe("VOTE-04/05 access modes and tokens", () => {
  test("authenticated mode refuses an anonymous voter", () => {
    const e = configureVoting({ voting_mode: "authenticated" });
    const { voter, needs } = voting.resolveVoter(e, { actor: null, voterCookie: "anything", ip: null });
    assert.equal(voter, null);
    assert.equal(needs, "sign_in");
  });

  test("email-gated mode refuses an unverified browser", () => {
    const e = configureVoting({ voting_mode: "email_gated" });
    const { voter, needs } = voting.resolveVoter(e, { actor: null, voterCookie: "unverified", ip: null });
    assert.equal(voter, null);
    assert.equal(needs, "email_verification");
  });

  test("a token verifies once and is then spent", () => {
    const e = events.byId(eventId)!;
    const { token } = voting.issueEmailToken(e, "Voter@Example.org");
    const voter = voting.redeemEmailToken(e, token, "browser-a", null);
    assert.equal(voter.kind, "email");
    assert.equal(voter.email_ci, "voter@example.org");
    assert.ok(voter.verified_at);
    assert.throws(() => voting.redeemEmailToken(e, token, "browser-b", null), /already been used/i);
  });

  test("an unknown, expired or revoked token is rejected", () => {
    const e = events.byId(eventId)!;
    assert.throws(() => voting.redeemEmailToken(e, "not-a-token", "b", null), /not valid/i);

    const { token } = voting.issueEmailToken(e, "expired@example.org");
    run(`UPDATE vote_tokens SET expires_at = ? WHERE email_ci = 'expired@example.org'`,
      new Date(Date.now() - 1000).toISOString());
    assert.throws(() => voting.redeemEmailToken(e, token, "b", null), /expired/i);

    const { token: t2 } = voting.issueEmailToken(e, "revoked@example.org");
    run(`UPDATE vote_tokens SET revoked_at = ? WHERE email_ci = 'revoked@example.org'`, nowIso());
    assert.throws(() => voting.redeemEmailToken(e, t2, "b", null), /revoked/i);
  });

  test("verification requests for one address are rate limited", () => {
    const e = events.byId(eventId)!;
    for (let i = 0; i < 5; i++) voting.issueEmailToken(e, "spammy@example.org");
    assert.throws(() => voting.issueEmailToken(e, "spammy@example.org"), /too many/i);
  });

  test("the same email cannot become two voters in one event", () => {
    const e = events.byId(eventId)!;
    const a = voting.redeemEmailToken(e, voting.issueEmailToken(e, "one@example.org").token, "br-1", null);
    const b = voting.redeemEmailToken(e, voting.issueEmailToken(e, "one@example.org").token, "br-2", null);
    assert.equal(a.id, b.id);
  });
});

describe("VOTE-06 interim totals stay private", () => {
  test("a participant cannot read the tally or the abuse review", () => {
    assert.throws(() => voting.tally(partCap), AccessDenied);
    assert.throws(() => voting.abuseSignals(partCap), AccessDenied);
  });

  test("public results stay null until voting closes and the organizer publishes them", () => {
    let e = configureVoting({
      voting_mode: "open_link", voting_results_public: 0,
      voting_open_at: new Date(Date.now() - 3600e3).toISOString(),
      voting_close_at: new Date(Date.now() + 3600e3).toISOString(),
    });
    assert.equal(voting.publicTally(e), null);                 // open, not public

    e = configureVoting({ voting_results_public: 1 });
    assert.equal(voting.publicTally(e), null);                 // public flag, still open

    e = configureVoting({ voting_close_at: new Date(Date.now() - 1000).toISOString() });
    assert.ok(voting.publicTally(e));                          // closed and published
    assert.ok(voting.tally(orgCap).length > 0);
  });
});

describe("VOTE-07 ballot ordering", () => {
  test("every eligible project appears exactly once", () => {
    const voter = newVoter();
    const order = voting.ballotOrder(eventId, voter.id);
    assert.equal(order.length, projectIds.length);
    assert.equal(new Set(order).size, order.length);
    assert.deepEqual([...order].sort(), [...projectIds].sort());
  });

  test("order is stable for one voter but differs between voters", () => {
    const a = newVoter(), b = newVoter();
    assert.deepEqual(voting.ballotOrder(eventId, a.id), voting.ballotOrder(eventId, a.id));
    assert.notDeepEqual(voting.ballotOrder(eventId, a.id), voting.ballotOrder(eventId, b.id));
  });
});

describe("VOTE-08/09 abuse review and invalidation", () => {
  test("shared-network and rapid-voting signals surface without asserting fraud", () => {
    const e = configureVoting({ voting_close_at: new Date(Date.now() + 3600e3).toISOString() });
    for (let i = 0; i < 5; i++) {
      const v = newVoter();
      voting.castVote(e, v, projectIds[i % projectIds.length], null);
    }
    const signals = voting.abuseSignals(orgCap);
    assert.ok(signals.some((s) => s.kind === "shared network"));
    assert.ok(signals.every((s) => typeof s.detail === "string" && s.detail.length > 0));
  });

  test("invalidation needs a reason, is audited, and removes votes from the count", () => {
    const e = events.byId(eventId)!;
    const voter = newVoter();
    voting.castVote(e, voter, projectIds[0], null);
    const before = voting.tally(orgCap).find((t) => t.project_id === projectIds[0])!.votes;

    assert.throws(() => voting.invalidateVotes(orgCap, voter.id, "   "), /reason/i);
    voting.invalidateVotes(orgCap, voter.id, "duplicate account");

    const after = voting.tally(orgCap).find((t) => t.project_id === projectIds[0])!.votes;
    assert.equal(after, before - 1);
    assert.ok(all(`SELECT id FROM audit_events WHERE action = 'vote.invalidate' AND subject_id = ?`, voter.id).length === 1);
    // History is preserved, not deleted.
    assert.ok(all(`SELECT id FROM votes WHERE voter_id = ? AND invalidated_reason = 'duplicate account'`, voter.id).length === 1);
    // A blocked voter cannot keep voting.
    const blocked = get<{ blocked_at: string }>(`SELECT blocked_at FROM voters WHERE id = ?`, voter.id)!;
    assert.ok(blocked.blocked_at);
  });
});

describe("COMMENT-01/02 comments and moderation", () => {
  test("comments are refused while the feature is off", () => {
    run(`UPDATE events SET comments_enabled = 0 WHERE id = ?`, eventId);
    assert.throws(() => comments.add(partCap, participant, projectIds[0], "hello"), /not enabled/i);
  });

  test("a valid comment persists and markup is stored as text, never as markup", () => {
    run(`UPDATE events SET comments_enabled = 1 WHERE id = ?`, eventId);
    const evil = '<img src=x onerror="alert(1)">  <script>steal()</script>';
    const c = comments.add(partCap, participant, projectIds[0], evil);
    const stored = get<{ body: string }>(`SELECT body FROM comments WHERE id = ?`, c.id)!;
    // Stored verbatim; React escapes it on render, so it is inert as text.
    assert.equal(stored.body, evil.trim());
    assert.ok(comments.forProject(projectIds[0]).some((x) => x.id === c.id));
  });

  test("length and emptiness are validated", () => {
    assert.throws(() => comments.add(partCap, participant, projectIds[0], "   "), /write something/i);
    assert.throws(() => comments.add(partCap, participant, projectIds[0], "x".repeat(2001)), /limited to/i);
  });

  test("posting is rate limited", () => {
    const fresh = accounts.register({ email: `talker-${Date.now()}@forgeboard.local`, password: "test123456", displayName: "Talker" });
    const actor = accounts.toActor(fresh);
    const cap = capabilityFor(actor, eventId);
    for (let i = 0; i < 5; i++) comments.add(cap, actor, projectIds[1], `comment ${i}`);
    assert.throws(() => comments.add(cap, actor, projectIds[1], "one more"), /too quickly/i);
  });

  test("another user cannot remove someone else's comment, but an organizer can with a reason", () => {
    const c = comments.add(partCap, participant, projectIds[2], "a thoughtful note");
    const other = accounts.toActor(accounts.register({
      email: `other-${Date.now()}@forgeboard.local`, password: "test123456", displayName: "Other",
    }));
    const otherCap = capabilityFor(other, eventId);
    assert.throws(() => comments.remove(otherCap, other, c.id, "because"), AccessDenied);

    assert.throws(() => comments.remove(orgCap, organizer, c.id, "  "), /reason/i);
    comments.remove(orgCap, organizer, c.id, "off topic");

    const after = comments.forProject(projectIds[2]).find((x) => x.id === c.id)!;
    assert.equal(after.status, "removed");
    assert.equal(after.body, "", "removed text must not be sent to the browser");
    // The author's original words are retained in the row, not destroyed.
    const raw = get<{ body: string }>(`SELECT body FROM comments WHERE id = ?`, c.id)!;
    assert.equal(raw.body, "a thoughtful note");
    assert.ok(all(`SELECT id FROM audit_events WHERE action = 'comment.moderate' AND subject_id = ?`, c.id).length === 1);
  });

  test("an author may withdraw their own comment without a reason", () => {
    const c = comments.add(partCap, participant, projectIds[3], "never mind");
    comments.remove(partCap, participant, c.id, "");
    assert.equal(comments.forProject(projectIds[3]).find((x) => x.id === c.id)!.status, "removed");
  });
});

describe("COMMUNITY-01 separation from judging", () => {
  test("voting and commenting leave judge ballots untouched", () => {
    const before = all<{ id: string; raw_weighted: number }>(
      `SELECT id, raw_weighted FROM reviews ORDER BY id`);
    const e = configureVoting({ voting_close_at: new Date(Date.now() + 3600e3).toISOString() });
    const voter = newVoter();
    voting.castVote(e, voter, projectIds[0], null);
    comments.add(partCap, participant, projectIds[4], "nice work");
    const after = all<{ id: string; raw_weighted: number }>(
      `SELECT id, raw_weighted FROM reviews ORDER BY id`);
    assert.deepEqual(before, after);
  });

  test("the comment reader never joins to review or vote data", () => {
    const rows = comments.forProject(projectIds[0]);
    for (const r of rows) {
      assert.equal(Object.hasOwn(r, "raw_weighted"), false);
      assert.equal(Object.hasOwn(r, "votes"), false);
    }
  });
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
