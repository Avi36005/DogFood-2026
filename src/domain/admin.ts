import type { Store } from '../db/store.ts';
import { conflict, notFound, ValidationError } from '../util/errors.ts';
import { iso } from '../util/time.ts';
import { grantRole, requireAdmin, rolesIn } from './access.ts';
import { createPasswordLink, findUser, findUserByEmail } from './accounts.ts';
import { record } from './audit.ts';
import { getEvent } from './events.ts';
import type { Actor, UserRow } from './types.ts';

export interface UserListRow extends UserRow {
  roles: string | null;
}

export function listUsers(store: Store, actor: Actor, q = ''): UserListRow[] {
  requireAdmin(actor);
  const like = `%${q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return store.all<UserListRow>(
    `SELECT u.*, (SELECT group_concat(e.slug || ':' || r.role, ', ') FROM event_roles r JOIN events e ON e.id = r.event_id WHERE r.user_id = u.id) AS roles
     FROM users u WHERE u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\'
     ORDER BY u.is_admin DESC, u.name LIMIT 200`,
    [like, like],
  );
}

export function setAdmin(store: Store, actor: Actor, userId: string, admin: boolean): void {
  const me = requireAdmin(actor);
  store.tx(() => {
    const user = findUser(store, userId);
    if (!user) throw notFound('No such person.');
    if (!admin && user.id === me.id) throw conflict('You cannot remove your own administrator access.');
    store.run('UPDATE users SET is_admin = ? WHERE id = ?', [admin ? 1 : 0, user.id]);
    record(store, actor, { action: admin ? 'admin.granted' : 'admin.revoked', subjectType: 'user', subjectId: user.id, summary: `${admin ? 'Made' : 'Removed'} ${user.email} ${admin ? 'an' : 'as'} administrator.` });
  });
}

/** The recovery path: there is no mail server, so an administrator hands the person this link. */
export function issueResetLink(store: Store, actor: Actor, userId: string): { user: UserRow; token: string } {
  requireAdmin(actor);
  return store.tx(() => {
    const user = findUser(store, userId);
    if (!user) throw notFound('No such person.');
    return { user, token: createPasswordLink(store, actor, user, user.password_hash ? 'reset' : 'setup', 2) };
  });
}

/** Admins appoint organizers for any event, including themselves; the grant is audited on that event. */
export function appointOrganizer(store: Store, actor: Actor, eventId: string, email: string): void {
  const admin = requireAdmin(actor);
  store.tx(() => {
    const event = getEvent(store, eventId);
    const user = findUserByEmail(store, email);
    if (!user) throw new ValidationError({ email: 'No account uses this email.' });
    if (rolesIn(store, user.id, event.id).has('judge')) throw new ValidationError({ email: 'This person judges the event, so they cannot organize it.' });
    grantRole(store, event.id, user.id, 'organizer', admin.id, iso(actor.now));
    record(store, actor, { eventId: event.id, action: 'role.granted', subjectType: 'user', subjectId: user.id, summary: `An administrator made ${user.email} an organizer of ${event.name}.` });
  });
}
