import { createHash, randomBytes } from "node:crypto";
import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { hashPassword, verifyPassword, passwordProblem } from "../auth/password.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type UserRow = {
  id: string; email: string; email_ci: string; password_hash: string; password_salt: string;
  display_name: string; global_role: "admin" | "user"; disabled_at: string | null;
  created_at: string; updated_at: string;
};

export function byEmail(email: string): UserRow | undefined {
  return get<UserRow>(`SELECT * FROM users WHERE email_ci = ?`, email.trim().toLowerCase());
}

export function byId(id: string): UserRow | undefined {
  return get<UserRow>(`SELECT * FROM users WHERE id = ?`, id);
}

export function emailProblem(email: string): string | null {
  const e = email.trim();
  if (e.length < 3 || e.length > 200) return "Enter a valid email address.";
  // Deliberately permissive: local-only deployments use addresses that public
  // validators reject, and we never send mail, so the address is an identifier.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "Enter a valid email address.";
  return null;
}

export function register(input: { email: string; password: string; displayName: string; globalRole?: "admin" | "user" }): UserRow {
  const emailErr = emailProblem(input.email);
  if (emailErr) throw new Error(emailErr);
  const pwErr = passwordProblem(input.password);
  if (pwErr) throw new Error(pwErr);
  const name = input.displayName.trim();
  if (name.length < 1 || name.length > 80) throw new Error("Display name must be 1-80 characters.");
  if (byEmail(input.email)) throw new Error("An account with that email already exists.");

  const { hash, salt } = hashPassword(input.password);
  const id = newId("usr");
  const now = nowIso();
  run(
    `INSERT INTO users (id, email, email_ci, password_hash, password_salt, display_name, global_role, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, input.email.trim(), input.email.trim().toLowerCase(), hash, salt, name,
    input.globalRole ?? "user", now, now,
  );
  const user = byId(id)!;
  audit.record({
    actor: { id: user.id, email: user.email, displayName: user.display_name, globalRole: user.global_role },
    action: "account.register", subjectType: "user", subjectId: id,
  });
  return user;
}

/** Constant-ish time: an unknown email still pays for one hash comparison. */
export function authenticate(email: string, password: string): UserRow | null {
  const user = byEmail(email);
  if (!user) {
    verifyPassword(password, "00".repeat(64), "00".repeat(16));
    return null;
  }
  if (user.disabled_at) return null;
  if (!verifyPassword(password, user.password_hash, user.password_salt)) return null;
  return user;
}

export function toActor(u: UserRow): Actor {
  return { id: u.id, email: u.email, displayName: u.display_name, globalRole: u.global_role };
}

export function setPassword(userId: string, password: string) {
  const pwErr = passwordProblem(password);
  if (pwErr) throw new Error(pwErr);
  const { hash, salt } = hashPassword(password);
  run(`UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`, hash, salt, nowIso(), userId);
  run(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, nowIso(), userId);
}

// ------------------------------------------------------------- recovery ----

/**
 * Local password recovery. Forgeboard has no mail server, so there is no
 * self-service "email me a link": an admin issues the link in the interface,
 * or the operator issues it at the command line with
 * `npm run user:reset -- someone@example.org`, and hands it over themselves.
 *
 * The token is returned once and only its hash is stored, like a session. It
 * expires, it works once, and redeeming it signs every existing session out.
 */
const RESET_TTL_MINUTES = 60;

export function issuePasswordReset(user: UserRow, by: Actor | null): { token: string; expiresAt: string } {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60e3).toISOString();
  run(
    `INSERT INTO password_resets (id, user_id, token_hash, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`,
    newId("pwr"), user.id, sha256(token), by?.id ?? null, nowIso(), expiresAt,
  );
  // The link is the secret; only the fact that one was issued is recorded.
  audit.record({
    actor: by, action: "account.reset.issue", subjectType: "user", subjectId: user.id,
    detail: { source: by ? "admin" : "command line", expiresAt },
  });
  return { token, expiresAt };
}

export function resetTokenUser(token: string): UserRow | null {
  const row = get<{ user_id: string; expires_at: string; used_at: string | null }>(
    `SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`, sha256(token));
  if (!row || row.used_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  const user = byId(row.user_id);
  return user && !user.disabled_at ? user : null;
}

export function redeemPasswordReset(token: string, newPassword: string): UserRow {
  const pwErr = passwordProblem(newPassword);
  if (pwErr) throw new Error(pwErr);
  return tx(() => {
    const row = get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
      `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`, sha256(token));
    if (!row) throw new Error("This reset link is not valid.");
    if (row.used_at) throw new Error("This reset link has already been used.");
    if (Date.parse(row.expires_at) < Date.now()) throw new Error("This reset link has expired. Ask for a new one.");
    const user = byId(row.user_id);
    if (!user) throw new Error("That account no longer exists.");
    if (user.disabled_at) throw new Error("That account is disabled.");

    run(`UPDATE password_resets SET used_at = ? WHERE id = ?`, nowIso(), row.id);
    // setPassword also revokes every existing session for the account.
    setPassword(user.id, newPassword);
    // Any other outstanding link for this account stops working too.
    run(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, nowIso(), user.id);
    audit.record({ actor: toActor(user), action: "account.reset.redeem", subjectType: "user", subjectId: user.id });
    return byId(user.id)!;
  });
}

export function search(q: string, limit = 20): UserRow[] {
  const like = `%${q.trim().toLowerCase()}%`;
  return all<UserRow>(
    `SELECT * FROM users WHERE email_ci LIKE ? OR lower(display_name) LIKE ? ORDER BY display_name LIMIT ?`,
    like, like, limit,
  );
}

export function listAll(limit = 500): UserRow[] {
  return all<UserRow>(`SELECT * FROM users ORDER BY created_at DESC LIMIT ?`, limit);
}

export function setGlobalRole(admin: Actor, userId: string, role: "admin" | "user") {
  if (admin.globalRole !== "admin") throw new Error("Only an instance admin can change global roles.");
  if (admin.id === userId && role !== "admin") {
    const others = get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE global_role = 'admin' AND id != ?`, userId)!.n;
    if (others === 0) throw new Error("This is the only admin account. Promote someone else first.");
  }
  run(`UPDATE users SET global_role = ?, updated_at = ? WHERE id = ?`, role, nowIso(), userId);
  audit.record({ actor: admin, action: "account.role", subjectType: "user", subjectId: userId, detail: { role } });
}

export function setDisabled(admin: Actor, userId: string, disabled: boolean) {
  if (admin.globalRole !== "admin") throw new Error("Only an instance admin can disable accounts.");
  if (admin.id === userId && disabled) throw new Error("You cannot disable your own account.");
  run(`UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?`, disabled ? nowIso() : null, nowIso(), userId);
  if (disabled) run(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, nowIso(), userId);
  audit.record({ actor: admin, action: disabled ? "account.disable" : "account.enable", subjectType: "user", subjectId: userId });
}
