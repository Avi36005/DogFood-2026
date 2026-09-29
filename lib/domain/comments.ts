import { all, get, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, requireOrganizer, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";
import { byId as eventById } from "./events.ts";

export const MAX_BODY = 2000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;

export type CommentRow = {
  id: string; project_id: string; event_id: string; author_user_id: string;
  body: string; status: "visible" | "removed";
  created_at: string; updated_at: string;
  moderated_by: string | null; moderated_at: string | null; moderation_reason: string;
  author_name?: string;
};

/**
 * Public read. Removed comments are returned as tombstones so a thread does not
 * silently reshape, but the original text is never sent to the browser.
 */
export function forProject(projectId: string): CommentRow[] {
  return all<CommentRow>(
    `SELECT c.id, c.project_id, c.event_id, c.author_user_id,
            CASE WHEN c.status = 'removed' THEN '' ELSE c.body END AS body,
            c.status, c.created_at, c.updated_at,
            c.moderated_by, c.moderated_at, c.moderation_reason,
            u.display_name AS author_name
       FROM comments c JOIN users u ON u.id = c.author_user_id
      WHERE c.project_id = ?
      ORDER BY c.created_at`,
    projectId,
  );
}

export function countVisible(projectId: string): number {
  return get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND status = 'visible'`, projectId)!.n;
}

/**
 * The author is always the authenticated actor. There is no author field in the
 * payload, so a request cannot claim to be somebody else.
 */
export function add(cap: Capability, actor: Actor, projectId: string, body: string): CommentRow {
  const event = eventById(cap.eventId);
  if (!event) throw new Error("Event not found.");
  if (!event.comments_enabled) throw new Error("Comments are not enabled for this event.");

  const project = get<{ id: string; status: string; event_id: string }>(
    `SELECT id, status, event_id FROM projects WHERE id = ?`, projectId);
  if (!project || project.event_id !== cap.eventId) throw new Error("That project is not in this event.");
  if (project.status !== "submitted") throw new AccessDenied("comments are only open on public submissions");

  const text = body.trim();
  if (!text) throw new Error("Write something first.");
  if (text.length > MAX_BODY) throw new Error(`Comments are limited to ${MAX_BODY} characters.`);

  const recent = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comments WHERE author_user_id = ? AND created_at > ?`,
    actor.id, new Date(Date.now() - RATE_WINDOW_MS).toISOString())!.n;
  if (recent >= RATE_MAX) throw new Error("You are posting too quickly. Wait a moment and try again.");

  const id = newId("cmt");
  const now = nowIso();
  run(
    `INSERT INTO comments (id, project_id, event_id, author_user_id, body, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'visible', ?,?)`,
    id, projectId, cap.eventId, actor.id, text, now, now,
  );
  audit.record({
    actor, eventId: cap.eventId, action: "comment.add",
    subjectType: "project", subjectId: projectId, detail: { commentId: id, length: text.length },
  });
  webhooks.emit(cap.eventId, "comment.added", { project_id: projectId, comment_id: id });
  return get<CommentRow>(`SELECT * FROM comments WHERE id = ?`, id)!;
}

/** An author may remove their own comment; only organizers may moderate others'. */
export function remove(cap: Capability, actor: Actor, commentId: string, reason: string) {
  const c = get<CommentRow>(`SELECT * FROM comments WHERE id = ?`, commentId);
  if (!c || c.event_id !== cap.eventId) throw new AccessDenied("comment not found in this event");

  const isAuthor = c.author_user_id === actor.id;
  if (!isAuthor) requireOrganizer(cap);
  if (!isAuthor && !reason.trim()) throw new Error("Record a reason when moderating someone else's comment.");

  // The author's text is retained in the row; only its visibility changes.
  run(
    `UPDATE comments SET status = 'removed', moderated_by = ?, moderated_at = ?, moderation_reason = ?, updated_at = ?
      WHERE id = ?`,
    actor.id, nowIso(), isAuthor ? "removed by author" : reason.trim(), nowIso(), commentId,
  );
  audit.record({
    actor, eventId: cap.eventId, action: isAuthor ? "comment.withdraw" : "comment.moderate",
    subjectType: "comment", subjectId: commentId,
    detail: { projectId: c.project_id, reason: isAuthor ? "author" : reason.trim() },
  });
}

export function restore(cap: Capability, commentId: string) {
  requireOrganizer(cap);
  run(`UPDATE comments SET status = 'visible', updated_at = ? WHERE id = ? AND event_id = ?`,
    nowIso(), commentId, cap.eventId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "comment.restore", subjectType: "comment", subjectId: commentId });
}

/** Organizer moderation queue: everything, including removed, with context. */
export function forEvent(cap: Capability, limit = 200): CommentRow[] {
  requireOrganizer(cap);
  return all<CommentRow>(
    `SELECT c.*, u.display_name AS author_name
       FROM comments c JOIN users u ON u.id = c.author_user_id
      WHERE c.event_id = ? ORDER BY c.created_at DESC LIMIT ?`,
    cap.eventId, limit,
  );
}
