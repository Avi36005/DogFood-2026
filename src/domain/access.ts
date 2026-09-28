import type { Store } from '../db/store.ts';
import { HttpError, unauthorized } from '../util/errors.ts';
import { actorLabel, type AuditEntry } from './audit.ts';
import type { Actor, EventRow, Role, UserRow } from './types.ts';

/**
 * A refusal that should be on the audit trail. The server records `audit` after the request's
 * transaction has rolled back, so a denied attempt is never lost with the work it tried to do.
 */
export class AccessDenied extends HttpError {
  readonly audit: AuditEntry;

  constructor(message: string, audit: AuditEntry) {
    super(403, message);
    this.audit = audit;
  }
}

export function rolesIn(store: Store, userId: string, eventId: string): Set<Role> {
  const rows = store.all<{ role: Role }>(
    'SELECT role FROM event_roles WHERE event_id = ? AND user_id = ?',
    [eventId, userId],
  );
  return new Set(rows.map((row) => row.role));
}

export function requireUser(actor: Actor): UserRow {
  if (!actor.user) throw unauthorized();
  return actor.user;
}

export function requireAdmin(actor: Actor): UserRow {
  const user = requireUser(actor);
  if (!user.is_admin) {
    throw new AccessDenied('Only an instance administrator can do this.', {
      action: 'access.denied',
      summary: `${actorLabel(actor)} was refused an administrator action.`,
    });
  }
  return user;
}

/**
 * The single gate for event-scoped actions. 401 without a session, 403 with the wrong role,
 * and the 403 is written to the event's audit trail with what was attempted.
 */
export function requireRole(store: Store, actor: Actor, event: EventRow, roles: Role[], attempted: string): UserRow {
  const user = requireUser(actor);
  const held = rolesIn(store, user.id, event.id);
  if (roles.some((role) => held.has(role))) return user;
  throw new AccessDenied(`This needs the ${roles.join(' or ')} role in ${event.name}.`, {
    eventId: event.id,
    action: 'access.denied',
    summary: `${actorLabel(actor)} was refused: ${attempted}.`,
    detail: { needed: roles, held: [...held] },
  });
}

export function requireOrganizer(store: Store, actor: Actor, event: EventRow, attempted: string): UserRow {
  return requireRole(store, actor, event, ['organizer'], attempted);
}

/** Events in which the user holds a role, with the roles, for navigation and dashboards. */
export function myEventRoles(store: Store, userId: string): { event: EventRow; roles: Set<Role> }[] {
  const rows = store.all<EventRow & { role: Role }>(
    `SELECT e.*, r.role FROM event_roles r JOIN events e ON e.id = r.event_id
     WHERE r.user_id = ? ORDER BY e.submissions_close_at DESC, e.name`,
    [userId],
  );
  const byEvent = new Map<string, { event: EventRow; roles: Set<Role> }>();
  for (const { role, ...event } of rows) {
    const entry = byEvent.get(event.id) ?? { event, roles: new Set<Role>() };
    entry.roles.add(role);
    byEvent.set(event.id, entry);
  }
  return [...byEvent.values()];
}

export function grantRole(store: Store, eventId: string, userId: string, role: Role, grantedBy: string | null, at: string): void {
  store.run(
    `INSERT INTO event_roles (event_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [eventId, userId, role, grantedBy, at],
  );
}
