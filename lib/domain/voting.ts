import { createHash, randomBytes } from "node:crypto";
import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, requireOrganizer, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";
import { byId as eventById, type EventRow } from "./events.ts";

export type VotingMode = "open_link" | "email_gated" | "authenticated";

export type VoterRow = {
  id: string; event_id: string; kind: "session" | "email" | "account";
  user_id: string | null; email_ci: string | null; session_hash: string | null;
  verified_at: string | null; blocked_at: string | null; created_at: string;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Salted so a stored hash is not a lookup table for the address space. */
function ipHash(ip: string | null): string | null {
  if (!ip) return null;
  return sha(`forgeboard-ip:${ip}`).slice(0, 32);
}

export function votingOpen(e: EventRow, at: Date = new Date()): boolean {
  if (!e.voting_enabled) return false;
  const t = at.getTime();
  if (e.voting_open_at && t < Date.parse(e.voting_open_at)) return false;
  if (e.voting_close_at && t > Date.parse(e.voting_close_at)) return false;
  return true;
}

export type VotingState =
  | "disabled" | "not_started" | "open" | "closed";

export function votingState(e: EventRow, at: Date = new Date()): VotingState {
  if (!e.voting_enabled) return "disabled";
  const t = at.getTime();
  if (e.voting_open_at && t < Date.parse(e.voting_open_at)) return "not_started";
  if (e.voting_close_at && t > Date.parse(e.voting_close_at)) return "closed";
  return "open";
}

// ------------------------------------------------------------- identity ----

/** Resolves (or creates) the voter for this request under the event's mode. */
export function resolveVoter(
  event: EventRow,
  ctx: { actor: Actor | null; voterCookie: string | null; ip: string | null },
): { voter: VoterRow | null; needs: "sign_in" | "email_verification" | null } {
  const mode = event.voting_mode as VotingMode;

  if (mode === "authenticated") {
    if (!ctx.actor) return { voter: null, needs: "sign_in" };
    const existing = get<VoterRow>(
      `SELECT * FROM voters WHERE event_id = ? AND user_id = ?`, event.id, ctx.actor.id);
    if (existing) return { voter: existing, needs: null };
    const id = newId("vtr");
    run(`INSERT INTO voters (id, event_id, kind, user_id, verified_at, ip_hash, created_at)
         VALUES (?,?, 'account', ?,?,?,?)`,
      id, event.id, ctx.actor.id, nowIso(), ipHash(ctx.ip), nowIso());
    return { voter: get<VoterRow>(`SELECT * FROM voters WHERE id = ?`, id)!, needs: null };
  }

  if (mode === "email_gated") {
    if (!ctx.voterCookie) return { voter: null, needs: "email_verification" };
    const v = get<VoterRow>(
      `SELECT * FROM voters WHERE event_id = ? AND session_hash = ?`, event.id, sha(ctx.voterCookie));
    if (!v || !v.verified_at) return { voter: null, needs: "email_verification" };
    return { voter: v, needs: null };
  }

  // open_link: a server-issued cookie. Honest about what that is worth.
  if (!ctx.voterCookie) return { voter: null, needs: null };
  const existing = get<VoterRow>(
    `SELECT * FROM voters WHERE event_id = ? AND session_hash = ?`, event.id, sha(ctx.voterCookie));
  if (existing) return { voter: existing, needs: null };
  const id = newId("vtr");
  run(`INSERT INTO voters (id, event_id, kind, session_hash, verified_at, ip_hash, created_at)
       VALUES (?,?, 'session', ?,?,?,?)`,
    id, event.id, sha(ctx.voterCookie), nowIso(), ipHash(ctx.ip), nowIso());
  return { voter: get<VoterRow>(`SELECT * FROM voters WHERE id = ?`, id)!, needs: null };
}

/** Issues a one-use, expiring token. Delivery is the operator's own channel. */
export function issueEmailToken(event: EventRow, email: string): { token: string; expiresAt: string } {
  const emailCi = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCi)) throw new Error("Enter a valid email address.");

  const recent = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM vote_tokens WHERE event_id = ? AND email_ci = ? AND created_at > ?`,
    event.id, emailCi, new Date(Date.now() - 3600e3).toISOString())!.n;
  if (recent >= 5) throw new Error("Too many verification requests for that address. Try again later.");

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  run(`INSERT INTO vote_tokens (id, event_id, email_ci, token_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
    newId("vtk"), event.id, emailCi, sha(token), nowIso(), expiresAt);
  return { token, expiresAt };
}

/** Redeems a token exactly once and binds it to this browser's voter cookie. */
export function redeemEmailToken(event: EventRow, token: string, voterCookie: string, ip: string | null): VoterRow {
  return tx(() => {
    const row = get<{ id: string; email_ci: string; expires_at: string; used_at: string | null; revoked_at: string | null }>(
      `SELECT id, email_ci, expires_at, used_at, revoked_at FROM vote_tokens WHERE event_id = ? AND token_hash = ?`,
      event.id, sha(token));
    if (!row) throw new Error("That verification link is not valid.");
    if (row.revoked_at) throw new Error("That verification link has been revoked.");
    if (row.used_at) throw new Error("That verification link has already been used.");
    if (Date.parse(row.expires_at) < Date.now()) throw new Error("That verification link has expired.");

    run(`UPDATE vote_tokens SET used_at = ? WHERE id = ?`, nowIso(), row.id);

    const existing = get<VoterRow>(`SELECT * FROM voters WHERE event_id = ? AND email_ci = ?`, event.id, row.email_ci);
    if (existing) {
      run(`UPDATE voters SET session_hash = ?, verified_at = ? WHERE id = ?`, sha(voterCookie), nowIso(), existing.id);
      return get<VoterRow>(`SELECT * FROM voters WHERE id = ?`, existing.id)!;
    }
    const id = newId("vtr");
    run(`INSERT INTO voters (id, event_id, kind, email_ci, session_hash, verified_at, ip_hash, created_at)
         VALUES (?,?, 'email', ?,?,?,?,?)`,
      id, event.id, row.email_ci, sha(voterCookie), nowIso(), ipHash(ip), nowIso());
    return get<VoterRow>(`SELECT * FROM voters WHERE id = ?`, id)!;
  });
}

// ---------------------------------------------------------------- ballot ---

/**
 * Ballot order. Randomised per voter with a server-controlled seed, so position
 * bias does not accumulate on the same projects, and stable for that voter so
 * the list does not jump between page loads.
 */
export function ballotOrder(eventId: string, voterId: string): string[] {
  const ids = all<{ id: string }>(
    `SELECT id FROM projects WHERE event_id = ? AND status = 'submitted' AND disqualified_at IS NULL ORDER BY id`, eventId,
  ).map((r) => r.id);
  return ids
    .map((id) => ({ id, k: sha(`${eventId}|${voterId}|${id}`) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.id);
}

// ----------------------------------------------------------------- votes ---

export function liveVotesFor(voterId: string): string[] {
  return all<{ project_id: string }>(
    `SELECT project_id FROM votes WHERE voter_id = ? AND retracted_at IS NULL AND invalidated_at IS NULL`,
    voterId,
  ).map((r) => r.project_id);
}

export function remainingBudget(event: EventRow, voterId: string): number {
  return Math.max(0, event.votes_per_voter - liveVotesFor(voterId).length);
}

export type CastOutcome = "created" | "already_counted" | "retracted";

/**
 * Casting is idempotent: repeating it for a project the voter already holds a
 * live vote on returns `already_counted` rather than spending budget twice.
 * The whole check-and-insert runs in one transaction, so two tabs racing for
 * the last vote cannot both win.
 */
export function castVote(
  event: EventRow, voter: VoterRow, projectId: string, ip: string | null,
): CastOutcome {
  if (voter.blocked_at) throw new AccessDenied("this voter has been blocked by an organizer");
  if (!votingOpen(event)) throw new Error("Voting is not open for this event.");

  return tx(() => {
    const project = get<{ id: string; status: string; event_id: string; disqualified_at: string | null }>(
      `SELECT id, status, event_id, disqualified_at FROM projects WHERE id = ?`, projectId);
    if (!project || project.event_id !== event.id) throw new Error("That project is not in this event.");
    if (project.status !== "submitted" || project.disqualified_at) {
      throw new Error("That project is not eligible for voting.");
    }

    const existing = get<{ id: string }>(
      `SELECT id FROM votes WHERE project_id = ? AND voter_id = ? AND retracted_at IS NULL AND invalidated_at IS NULL`,
      projectId, voter.id);
    if (existing) return "already_counted" as const;

    const used = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM votes WHERE voter_id = ? AND retracted_at IS NULL AND invalidated_at IS NULL`,
      voter.id)!.n;
    if (used >= event.votes_per_voter) {
      throw new Error(`You have used all ${event.votes_per_voter} of your votes. Retract one to move it.`);
    }

    run(`INSERT INTO votes (id, event_id, project_id, voter_id, created_at) VALUES (?,?,?,?,?)`,
      newId("vot"), event.id, projectId, voter.id, nowIso());
    run(`UPDATE voters SET ip_hash = COALESCE(ip_hash, ?) WHERE id = ?`, ipHash(ip), voter.id);
    audit.record({
      actor: null, eventId: event.id, action: "vote.cast", subjectType: "project", subjectId: projectId,
      detail: { voterKind: voter.kind, voterId: voter.id },
    });
    // No totals in the payload: the hidden window applies to webhooks too.
    webhooks.emit(event.id, "vote.cast", { project_id: projectId });
    return "created" as const;
  });
}

export function retractVote(event: EventRow, voter: VoterRow, projectId: string): CastOutcome {
  if (!votingOpen(event)) throw new Error("Voting is not open for this event.");
  return tx(() => {
    const existing = get<{ id: string }>(
      `SELECT id FROM votes WHERE project_id = ? AND voter_id = ? AND retracted_at IS NULL AND invalidated_at IS NULL`,
      projectId, voter.id);
    if (!existing) return "already_counted" as const;   // nothing to undo; safe to retry
    run(`UPDATE votes SET retracted_at = ? WHERE id = ?`, nowIso(), existing.id);
    audit.record({
      actor: null, eventId: event.id, action: "vote.retract", subjectType: "project", subjectId: projectId,
      detail: { voterId: voter.id },
    });
    return "retracted" as const;
  });
}

// ---------------------------------------------------------------- totals ---

export type Tally = { project_id: string; project_name: string; votes: number };

/** Organizer-only. Interim totals never reach a non-organizer by any route. */
export function tally(cap: Capability): Tally[] {
  requireOrganizer(cap);
  return all<Tally>(
    `SELECT p.id AS project_id, p.name AS project_name,
            COUNT(v.id) AS votes
       FROM projects p
       LEFT JOIN votes v ON v.project_id = p.id AND v.retracted_at IS NULL AND v.invalidated_at IS NULL
      WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
      GROUP BY p.id, p.name
      ORDER BY votes DESC, p.name`,
    cap.eventId,
  );
}

/**
 * Public community results. Available only once voting has closed AND the
 * organizer has explicitly made them public. Judge results stay separate.
 */
export function publicTally(event: EventRow): Tally[] | null {
  if (!event.voting_enabled) return null;
  if (!event.voting_results_public) return null;
  if (votingState(event) !== "closed") return null;
  return all<Tally>(
    `SELECT p.id AS project_id, p.name AS project_name, COUNT(v.id) AS votes
       FROM projects p
       LEFT JOIN votes v ON v.project_id = p.id AND v.retracted_at IS NULL AND v.invalidated_at IS NULL
      WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
      GROUP BY p.id, p.name ORDER BY votes DESC, p.name`,
    event.id,
  );
}

// ----------------------------------------------------------- abuse review --

export type AbuseSignal = {
  kind: string; detail: string; count: number; voter_id: string | null;
};

/**
 * Review signals, not accusations. Each row is something an organizer might
 * want to look at; none of it asserts fraud on its own.
 */
export function abuseSignals(cap: Capability): AbuseSignal[] {
  requireOrganizer(cap);
  const out: AbuseSignal[] = [];

  for (const r of all<{ ip_hash: string; n: number }>(
    `SELECT ip_hash, COUNT(*) AS n FROM voters
      WHERE event_id = ? AND ip_hash IS NOT NULL GROUP BY ip_hash HAVING n > 3 ORDER BY n DESC LIMIT 20`,
    cap.eventId)) {
    out.push({
      kind: "shared network",
      detail: `${r.n} voters share one network fingerprint. A university or office NATs many people behind one address, so this is a signal, not proof.`,
      count: r.n, voter_id: null,
    });
  }

  for (const r of all<{ voter_id: string; n: number }>(
    `SELECT voter_id, COUNT(*) AS n FROM votes
      WHERE event_id = ? AND created_at > ? GROUP BY voter_id HAVING n >= 5 ORDER BY n DESC LIMIT 20`,
    cap.eventId, new Date(Date.now() - 60_000).toISOString())) {
    out.push({
      kind: "rapid voting",
      detail: `${r.n} votes from one voter within a minute.`,
      count: r.n, voter_id: r.voter_id,
    });
  }

  for (const r of all<{ email_ci: string; n: number }>(
    `SELECT email_ci, COUNT(*) AS n FROM vote_tokens
      WHERE event_id = ? GROUP BY email_ci HAVING n >= 4 ORDER BY n DESC LIMIT 20`,
    cap.eventId)) {
    out.push({
      kind: "repeated verification",
      detail: `${r.n} verification tokens requested for one address.`,
      count: r.n, voter_id: null,
    });
  }
  return out;
}

export function invalidateVotes(cap: Capability, voterId: string, reason: string) {
  requireOrganizer(cap);
  if (!reason.trim()) throw new Error("Record a reason when invalidating votes.");
  const n = all<{ id: string }>(
    `SELECT id FROM votes WHERE voter_id = ? AND invalidated_at IS NULL`, voterId).length;
  run(
    `UPDATE votes SET invalidated_at = ?, invalidated_by = ?, invalidated_reason = ?
      WHERE voter_id = ? AND invalidated_at IS NULL`,
    nowIso(), cap.actor!.id, reason.trim(), voterId,
  );
  run(`UPDATE voters SET blocked_at = ?, blocked_reason = ? WHERE id = ?`, nowIso(), reason.trim(), voterId);
  audit.record({
    actor: cap.actor, eventId: cap.eventId, action: "vote.invalidate",
    subjectType: "voter", subjectId: voterId, detail: { votes: n, reason: reason.trim() },
  });
}
