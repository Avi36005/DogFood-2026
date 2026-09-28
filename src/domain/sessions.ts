import type { Store } from '../db/store.ts';
import { hashToken, newToken } from '../util/tokens.ts';
import { addDays, iso } from '../util/time.ts';
import type { UserRow } from './types.ts';

export const SESSION_DAYS = 14;

/**
 * Server-side sessions. The cookie holds a random token; the database holds its hash.
 * Signing out deletes the row, so revocation is immediate.
 */
export function createSession(store: Store, userId: string, now: Date, options: { token?: string; days?: number; demo?: boolean } = {}): string {
  const token = options.token ?? newToken();
  store.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, is_demo) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (token_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
    [hashToken(token), userId, iso(now), iso(addDays(now, options.days ?? SESSION_DAYS)), options.demo ? 1 : 0],
  );
  return token;
}

export function findSessionUser(store: Store, token: string, now: Date): UserRow | null {
  const user = store.get<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [hashToken(token), iso(now)],
  );
  return user ?? null;
}

export function destroySession(store: Store, token: string): void {
  store.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

/** After a password change every other session of that person ends. */
export function destroyUserSessions(store: Store, userId: string, exceptToken?: string): void {
  if (exceptToken) {
    store.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ? AND is_demo = 0', [userId, hashToken(exceptToken)]);
  } else {
    store.run('DELETE FROM sessions WHERE user_id = ? AND is_demo = 0', [userId]);
  }
}

export function pruneExpiredSessions(store: Store, now: Date): number {
  return store.run('DELETE FROM sessions WHERE expires_at <= ?', [iso(now)]).changes;
}
