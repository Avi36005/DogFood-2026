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

