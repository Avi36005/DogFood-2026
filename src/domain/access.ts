import type { Store } from '../db/store.ts';
import { HttpError, unauthorized } from '../util/errors.ts';
import { actorLabel, record, type AuditEntry } from './audit.ts';
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
 * Instance administrators hold organizer powers in every event, as the DOGFOOD isolation matrix
 * expects (FIG. 02: an admin may read peer scores, other tracks, aggregates and the audit log).
 * An administrator who is not an organizer of the event is never silent about it: each use is
 * written to that event's audit trail with what they did. Returns false for everyone else.
 */
export function adminOverride(store: Store, actor: Actor, eventId: string, attempted: string): boolean {
  const user = actor.user;
  if (!user?.is_admin) return false;
  if (rolesIn(store, user.id, eventId).has('organizer')) return true;
  record(store, actor, {
    eventId,
    action: 'admin.access',
    summary: `${actorLabel(actor)} used administrator access (not an organizer of this event) to ${attempted}.`,
  });
  return true;
}

/** Organizer powers in an event: its organizers, and administrators (audited, see adminOverride). */
export function actsAsOrganizer(store: Store, actor: Actor, eventId: string, attempted: string): boolean {
  if (actor.user && rolesIn(store, actor.user.id, eventId).has('organizer')) return true;
  return adminOverride(store, actor, eventId, attempted);
}

/**
 * The single gate for event-scoped actions. 401 without a session, 403 with the wrong role,
 * and the 403 is written to the event's audit trail with what was attempted. Where the organizer
 * role would do, an administrator passes too, and that is audited.
 */
export function requireRole(store: Store, actor: Actor, event: EventRow, roles: Role[], attempted: string): UserRow {
  const user = requireUser(actor);
  const held = rolesIn(store, user.id, event.id);
  if (roles.some((role) => held.has(role))) return user;
  if (roles.includes('organizer') && adminOverride(store, actor, event.id, attempted)) return user;
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
