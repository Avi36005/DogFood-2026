/**
 * Comments on gallery projects (T3). Any signed-in account may comment on a public project.
 * Nothing is deleted: an author can withdraw their own comment, and an organizer of the event
 * can hide one with a written reason. Hidden comments disappear for everyone else and stay
 * visible, marked, to organizers. Both actions are on the audit trail. Posting is rate limited
 * per account in the route, and every comment is escaped wherever it is shown.
 */
import type { Store } from '../db/store.ts';
import { notFound } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { newId } from '../util/tokens.ts';
import { iso } from '../util/time.ts';
import { AccessDenied, requireUser, rolesIn } from './access.ts';
import { actorLabel, record } from './audit.ts';
import type { Actor, ProjectRow } from './types.ts';

export const COMMENT_MAX = 2000;

export interface CommentView {
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
  hidden_at: string | null;
  hidden_reason: string | null;
  /** The caller may withdraw (author) or hide (organizer) this comment. */
  canHide: boolean;
}

function publicProject(store: Store, projectId: string): ProjectRow {
  const project = store.get<ProjectRow>("SELECT * FROM projects WHERE id = ? AND status = 'submitted' AND superseded_by IS NULL", [projectId]);
  if (!project) throw notFound('No such project.');
  return project;
}

export function listComments(store: Store, actor: Actor, project: ProjectRow): CommentView[] {
  const organizer = actor.user ? rolesIn(store, actor.user.id, project.event_id).has('organizer') : false;
  return store
    .all<Omit<CommentView, 'canHide'>>(
      `SELECT c.id, c.author_id, u.name AS author_name, c.body, c.created_at, c.hidden_at, c.hidden_reason
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.project_id = ? ORDER BY c.created_at, c.id`,
      [project.id],
    )
    .filter((c) => organizer || c.hidden_at === null)
    .map((c) => ({ ...c, canHide: c.hidden_at === null && (organizer || c.author_id === actor.user?.id) }));
}

export function addComment(store: Store, actor: Actor, projectId: string, body: Body): string {
  const user = requireUser(actor);
  const form = new FormReader(body);
  const text = form.text('body', { label: 'Comment', required: true, max: COMMENT_MAX });
  form.assertValid();
  return store.tx(() => {
    const project = publicProject(store, projectId);
    const id = newId('cmt');
    store.run('INSERT INTO comments (id, project_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [id, project.id, user.id, text, iso(actor.now)]);
    record(store, actor, { eventId: project.event_id, action: 'comment.added', subjectType: 'comment', subjectId: id, summary: `${actorLabel(actor)} commented on “${project.title}”.` });
    return id;
  });
}

export function hideComment(store: Store, actor: Actor, commentId: string, body: Body): ProjectRow {
  const user = requireUser(actor);
  return store.tx(() => {
    const comment = store.get<{ id: string; author_id: string; project_id: string; hidden_at: string | null }>('SELECT id, author_id, project_id, hidden_at FROM comments WHERE id = ?', [commentId]);
    if (!comment || comment.hidden_at) throw notFound('No such comment.');
    const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [comment.project_id]) as ProjectRow;
    const organizer = rolesIn(store, user.id, project.event_id).has('organizer');
    const author = comment.author_id === user.id;
    if (!organizer && !author) {
      throw new AccessDenied('Only the author or an organizer of this event can take a comment down.', {
        eventId: project.event_id,
        action: 'access.denied',
        subjectType: 'comment',
        subjectId: commentId,
        summary: `${actorLabel(actor)} was refused: hide someone else's comment on “${project.title}”.`,
      });
    }
    let reason = 'Withdrawn by its author.';
    if (!author) {
      const form = new FormReader(body);
      reason = form.text('reason', { label: 'Reason', required: true, max: 300 });
      form.assertValid();
    }
    store.run('UPDATE comments SET hidden_at = ?, hidden_by = ?, hidden_reason = ? WHERE id = ?', [iso(actor.now), user.id, reason, commentId]);
    record(store, actor, {
      eventId: project.event_id,
      action: 'comment.hidden',
      subjectType: 'comment',
      subjectId: commentId,
      summary: `${actorLabel(actor)} ${author ? 'withdrew their comment' : 'hid a comment'} on “${project.title}”${author ? '' : `: ${reason}`}.`,
    });
    return project;
  });
}
