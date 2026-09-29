import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { all, get, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";

export const SESSION_COOKIE = "forgeboard_session";
const SESSION_DAYS = 14;

export type Actor = {
  id: string;
  email: string;
  displayName: string;
  globalRole: "admin" | "user";
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a session and returns the raw token. Only the hash is persisted. */
export function issueSession(userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    newId("ses"), userId, hashToken(token), nowIso(), expiresAt,
  );
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.FORGEBOARD_INSECURE_COOKIES !== "1",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) run(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ?`, nowIso(), hashToken(token));
  jar.delete(SESSION_COOKIE);
}

/** The single place a request is turned into an identity. Returns null for visitors. */
export async function currentActor(): Promise<Actor | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = get<{
    id: string; email: string; display_name: string; global_role: "admin" | "user";
  }>(
    `SELECT u.id, u.email, u.display_name, u.global_role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.disabled_at IS NULL`,
    hashToken(token), nowIso(),
  );
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name, globalRole: row.global_role };
}

export function revokeAllSessions(userId: string) {
  run(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, nowIso(), userId);
}

export function activeSessionCount(userId: string): number {
  return all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    userId, nowIso(),
  )[0].n;
}
