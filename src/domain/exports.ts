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

/** Builds one CSV for an organizer. Exports are available at every stage, before and after publishing. */
export function exportCsv(store: Store, actor: Actor, event: EventRow, kind: string): { filename: string; body: string } {
  requireOrganizer(store, actor, event, `export ${kind} as CSV`);
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw badRequest(`Unknown export "${kind}". Use one of: ${EXPORT_KINDS.join(', ')}.`);
  const filename = `${event.slug}-${kind}.csv`;
  switch (kind as ExportKind) {
    case 'results': {
      const r = computeStandings(store, event);
      const rows: CsvValue[][] = r.standings.map((s) => [
        s.rank, s.project_id, s.title, s.team_name, s.track_name, s.review_count, round(s.raw_mean), round(s.score), s.raw_rank, s.low_coverage,
        event.results_published_at ? 'published' : 'preview',
      ]);
      return { filename, body: toCsv(['rank', 'project_id', 'title', 'team', 'track', 'reviews', 'raw_mean', 'normalized_score', 'raw_rank', 'low_coverage', 'status'], rows) };
    }
    case 'reviews': {
      const criteria = listCriteria(store, event.id);
      const reviews = store.all<{ assignment_id: string; judge_id: string; judge_name: string; project_id: string; title: string; status: string; comment: string; submitted_at: string | null }>(
        `SELECT a.id AS assignment_id, a.judge_id, u.name AS judge_name, p.id AS project_id, p.title, r.status, r.comment, r.submitted_at
         FROM assignments a JOIN reviews r ON r.assignment_id = a.id JOIN users u ON u.id = a.judge_id JOIN projects p ON p.id = a.project_id
         WHERE a.event_id = ? ORDER BY p.id, u.name`,
        [event.id],
      );
      const rows = reviews.map((review) => {
        const values = new Map(store.all<{ criterion_id: string; value: number }>('SELECT criterion_id, value FROM review_scores WHERE assignment_id = ?', [review.assignment_id]).map((s) => [s.criterion_id, s.value]));
        return [review.judge_id, review.judge_name, review.project_id, review.title, review.status, ...criteria.map((c) => values.get(c.id) ?? null),
          round(weightedScore(values, criteria)), review.comment, review.submitted_at];
      });
      return { filename, body: toCsv(['judge_id', 'judge', 'project_id', 'title', 'status', ...criteria.map((c) => c.key), 'weighted', 'comment', 'submitted_at'], rows) };
    }
    case 'projects': {
      const projects = store.all<Record<string, CsvValue>>(
        `SELECT p.id, p.title, p.summary, t.id AS team_id, t.name AS team, tr.name AS track, p.status, p.superseded_by, p.submitted_at,
           p.repo_url, p.demo_url, p.video_url, p.version, p.updated_at
         FROM projects p JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id WHERE p.event_id = ? ORDER BY p.id`,
        [event.id],
      );
      const headers = ['id', 'title', 'summary', 'team_id', 'team', 'track', 'status', 'superseded_by', 'submitted_at', 'repo_url', 'demo_url', 'video_url', 'version', 'updated_at'];
      return { filename, body: toCsv(headers, projects.map((p) => headers.map((h) => p[h] ?? null))) };
    }
    case 'judges': {
      const standings = computeStandings(store, event);
      const stats = new Map(standings.judges.map((j) => [j.judge_id, j]));
      const tracks = new Map(listTracks(store, event.id).map((t) => [t.id, t.name]));
      const judges = store.all<{ id: string; name: string; email: string }>(
        "SELECT u.id, u.name, u.email FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.role = 'judge' ORDER BY u.id",
        [event.id],
      );
      const rows = judges.map((j) => {
        const trackNames = store.all<{ track_id: string }>('SELECT track_id FROM judge_tracks WHERE event_id = ? AND judge_id = ?', [event.id, j.id]).map((t) => tracks.get(t.track_id) ?? t.track_id);
        const s = stats.get(j.id);
        return [j.id, j.name, j.email, trackNames.join('; ') || 'all', s?.review_count ?? 0, round(s?.mean_given ?? null), round(s?.offset ?? null), s?.flags.join('; ') ?? ''];
      });
      return { filename, body: toCsv(['judge_id', 'name', 'email', 'tracks', 'submitted_reviews', 'mean_given', 'offset', 'flags'], rows) };
    }
    case 'assignments': {
      const rows = store.all<Record<string, CsvValue>>(
        `SELECT a.id, a.project_id, p.title, a.judge_id, u.name AS judge, a.source, a.created_at, coalesce(r.status, 'not started') AS review_status
         FROM assignments a JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.judge_id LEFT JOIN reviews r ON r.assignment_id = a.id
         WHERE a.event_id = ? ORDER BY a.project_id, u.name`,
        [event.id],
      );
      const headers = ['id', 'project_id', 'title', 'judge_id', 'judge', 'source', 'created_at', 'review_status'];
      return { filename, body: toCsv(headers, rows.map((r) => headers.map((h) => r[h] ?? null))) };
    }
    case 'audit': {
      const rows = listAudit(store, event.id, { limit: 500 });
      let before = rows.at(-1)?.id;
      while (before && rows.length % 500 === 0) {
        const more = listAudit(store, event.id, { limit: 500, before });
        if (!more.length) break;
        rows.push(...more);
        before = more.at(-1)?.id;
      }
      return {
        filename,
        body: toCsv(['id', 'at', 'actor', 'action', 'subject_type', 'subject_id', 'summary', 'ip'], rows.map((r) => [r.id, r.at, r.actor_label, r.action, r.subject_type, r.subject_id, r.summary, r.ip])),
      };
    }
  }
}
