import type { Store } from '../db/store.ts';
import { grantRole, requireAdmin, requireOrganizer } from './access.ts';
import { record } from './audit.ts';
import type { Actor, CriterionRow, EventRow, PrizeRow, TrackRow } from './types.ts';
import { conflict, HttpError, notFound, ValidationError } from '../util/errors.ts';
import { FormReader, slugify, type Body } from '../util/form.ts';
import { newId } from '../util/tokens.ts';
import { formatUtc, iso } from '../util/time.ts';

// Lifecycle ----------------------------------------------------------------------

export type PhaseKey = 'upcoming' | 'open' | 'judging' | 'judging-closed' | 'published';

export interface Phase {
  key: PhaseKey;
  label: string;
}

/** The phase is derived from the dates, never stored, so it cannot drift from the rules that enforce it. */
export function phaseOf(event: EventRow, now: Date): Phase {
  const at = iso(now);
  if (event.results_published_at) return { key: 'published', label: 'Results published' };
  if (event.submissions_open_at && at < event.submissions_open_at) return { key: 'upcoming', label: 'Opens soon' };
  if (at < event.submissions_close_at) return { key: 'open', label: 'Accepting submissions' };
  if (event.judging_close_at && at >= event.judging_close_at) return { key: 'judging-closed', label: 'Judging closed' };
  return { key: 'judging', label: 'Judging' };
}

export function submissionsOpen(event: EventRow, now: Date): boolean {
  return phaseOf(event, now).key === 'open';
}

/**
 * The deadline. Called inside the same transaction as every write that creates or changes
 * a team or a project, against the server clock. The boundary is exclusive: at
 * submissions_close_at exactly, the event is closed.
 */
export function assertSubmissionsOpen(event: EventRow, now: Date): void {
  const at = iso(now);
  if (event.submissions_open_at && at < event.submissions_open_at) {
    throw new HttpError(403, `Submissions for ${event.name} open on ${formatUtc(event.submissions_open_at)}.`);
  }
  if (at >= event.submissions_close_at) {
    throw new HttpError(403, `Submissions for ${event.name} closed on ${formatUtc(event.submissions_close_at)}.`);
  }
}

export function judgingOpen(event: EventRow, now: Date): boolean {
  return phaseOf(event, now).key === 'judging';
}

export function assertJudgingOpen(event: EventRow, now: Date): void {
  const phase = phaseOf(event, now);
  if (phase.key === 'judging') return;
  const reason: Record<Exclude<PhaseKey, 'judging'>, string> = {
    upcoming: 'Judging starts after submissions close.',
    open: `Judging starts when submissions close on ${formatUtc(event.submissions_close_at)}.`,
    'judging-closed': 'Judging has closed.',
    published: 'Results are published, so reviews are final.',
  };
  throw new HttpError(403, reason[phase.key]);
}

// Reads ---------------------------------------------------------------------------

export function getEvent(store: Store, idOrSlug: string): EventRow {
  const event = store.get<EventRow>('SELECT * FROM events WHERE id = ? OR slug = ?', [idOrSlug, idOrSlug]);
  if (!event) throw notFound('No such event.');
  return event;
}

export function listEvents(store: Store): EventRow[] {
  return store.all<EventRow>('SELECT * FROM events ORDER BY submissions_close_at DESC, name');
}

export function listTracks(store: Store, eventId: string): TrackRow[] {
  return store.all<TrackRow>('SELECT * FROM tracks WHERE event_id = ? ORDER BY position, name', [eventId]);
}

export function listPrizes(store: Store, eventId: string): (PrizeRow & { track_name: string | null })[] {
  return store.all(
    `SELECT p.*, t.name AS track_name FROM prizes p LEFT JOIN tracks t ON t.id = p.track_id
     WHERE p.event_id = ? ORDER BY p.position, p.name`,
    [eventId],
  );
}

export function listCriteria(store: Store, eventId: string): CriterionRow[] {
  return store.all<CriterionRow>('SELECT * FROM criteria WHERE event_id = ? ORDER BY position, name', [eventId]);
}

export interface EventCounts {
  teams: number;
  submitted: number;
  drafts: number;
  judges: number;
}

export function eventCounts(store: Store, eventId: string): EventCounts {
  return store.get<EventCounts>(
    `SELECT
       (SELECT count(*) FROM teams WHERE event_id = $id) AS teams,
       (SELECT count(*) FROM projects WHERE event_id = $id AND status = 'submitted' AND superseded_by IS NULL) AS submitted,
       (SELECT count(*) FROM projects WHERE event_id = $id AND status = 'draft') AS drafts,
       (SELECT count(*) FROM event_roles WHERE event_id = $id AND role = 'judge') AS judges`,
    { id: eventId },
  ) as EventCounts;
}

// Writes --------------------------------------------------------------------------

interface EventFields {
  name: string;
  tagline: string;
  description: string;
  submissions_open_at: string | null;
  submissions_close_at: string;
  judging_close_at: string | null;
  max_team_size: number;
  reviews_per_project: number;
}

function readEventFields(form: FormReader): EventFields {
  const fields: EventFields = {
    name: form.text('name', { label: 'Name', required: true, max: 120 }),
    tagline: form.text('tagline', { label: 'Tagline', max: 200 }),
    description: form.text('description', { label: 'Description', max: 5000 }),
    submissions_open_at: form.instant('submissions_open_at', { label: 'Submissions open' }),
    submissions_close_at: form.instant('submissions_close_at', { label: 'Submission deadline', required: true }) ?? '',
    judging_close_at: form.instant('judging_close_at', { label: 'Judging closes' }),
    max_team_size: form.int('max_team_size', { label: 'Maximum team size', min: 1, max: 20, fallback: 4 }),
    reviews_per_project: form.int('reviews_per_project', { label: 'Reviews per project', min: 1, max: 20, fallback: 3 }),
  };
  if (fields.submissions_open_at && fields.submissions_close_at && fields.submissions_open_at >= fields.submissions_close_at) {
    form.fail('submissions_open_at', 'Submissions must open before the deadline.');
  }
  if (fields.judging_close_at && fields.submissions_close_at && fields.judging_close_at <= fields.submissions_close_at) {
    form.fail('judging_close_at', 'Judging must close after the submission deadline.');
  }
  return fields;
}

