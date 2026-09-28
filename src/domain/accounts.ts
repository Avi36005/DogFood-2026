import type { Store } from '../db/store.ts';
import { conflict, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { hashToken, newId, newToken } from '../util/tokens.ts';
import { addDays, iso } from '../util/time.ts';
import { record } from './audit.ts';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.ts';
import { destroyUserSessions } from './sessions.ts';
import type { Actor, UserRow } from './types.ts';

export function findUserByEmail(store: Store, email: string): UserRow | undefined {
  return store.get<UserRow>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
}

export function findUser(store: Store, id: string): UserRow | undefined {
  return store.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

/** Finds a person by email or creates them without a password (they claim the account through a link). */
export function ensureUser(store: Store, email: string, name: string, now: Date, id?: string): UserRow {
  const existing = findUserByEmail(store, email);
  if (existing) return existing;
  const user: UserRow = {
    id: id ?? newId('usr'),
    email: email.trim().toLowerCase(),
    name: name.trim() || email.split('@')[0] || email,
    password_hash: null,
    is_admin: 0,
    created_at: iso(now),
  };
  store.run('INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    user.id, user.email, user.name, user.password_hash, user.is_admin, user.created_at,
  ]);
  return user;
}

export async function signUp(store: Store, actor: Actor, body: Body): Promise<UserRow> {
  const form = new FormReader(body);
  const name = form.text('name', { label: 'Name', required: true, max: 120 });
  const email = form.email('email');
  const password = form.raw('password');
  const problem = passwordProblem(password);
  if (problem) form.fail('password', problem);
  form.assertValid();

  const existing = findUserByEmail(store, email);
  if (existing?.password_hash) throw new ValidationError({ email: 'An account with this email already exists. Sign in instead.' });
  if (existing) {
    // Imported and invited people exist without a password. Letting anyone "sign up" as them
    // would hand their judge or team seat to whoever typed the email first.
    throw new ValidationError({ email: 'This email was added by an organizer. Use the link they gave you, or ask them for a new one.' });
  }

  const passwordHash = await hashPassword(password);
  return store.tx(() => {
    const user = ensureUser(store, email, name, actor.now);
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
    record(store, { ...actor, user }, { action: 'account.created', subjectType: 'user', subjectId: user.id, summary: `${name} <${email}> created an account.` });
    return { ...user, password_hash: passwordHash };
  });
}

// Used when the email is unknown, so a failed sign-in takes as long whether or not the account exists.
const DECOY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function signIn(store: Store, email: string, password: string): Promise<UserRow | null> {
  const user = findUserByEmail(store, email);
  const ok = await verifyPassword(password, user?.password_hash ?? DECOY_HASH);
  return ok && user?.password_hash ? user : null;
}

