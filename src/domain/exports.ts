import type { Store } from '../db/store.ts';
import { toCsv, type CsvValue } from '../util/csv.ts';
import { badRequest } from '../util/errors.ts';
import { requireOrganizer } from './access.ts';
import { listAudit } from './audit.ts';
import { listCriteria, listTracks } from './events.ts';
import { weightedScore } from './normalization.ts';
import { computeStandings } from './results.ts';
import type { Actor, EventRow } from './types.ts';

export const EXPORT_KINDS = ['results', 'reviews', 'projects', 'judges', 'assignments', 'audit'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_DESCRIPTIONS: Record<ExportKind, string> = {
  results: 'Ranking with raw mean, normalized score, review count and coverage flag.',
  reviews: 'Every review: judge, project, each criterion, weighted score, comment, status.',
  projects: 'Every project including drafts, withdrawn and replaced ones, with team and links.',
  judges: 'Judges with tracks, progress, fitted offset and flags.',
  assignments: 'Who was assigned what, how (fixture, auto, manual) and review status.',
  audit: 'The full audit trail for this event.',
};

const round = (value: number | null, places = 4): number | null =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

