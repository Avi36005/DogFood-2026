import type { Store } from '../db/store.ts';
import { listAudit, type AuditRow } from './audit.ts';
import { listJudges } from './judging.ts';
import type { EventRow } from './types.ts';

export interface Progress {
  projects: { submitted: number; drafts: number; withdrawn: number; replaced: number };
  reviews: { assigned: number; submitted: number; drafts: number; notStarted: number };
  coverage: { target: number; atTarget: number; below: number; none: number; histogram: { reviews: number; projects: number }[] };
  tracks: { id: string; name: string; projects: number; reviews: number; atTarget: number; judges: number }[];
  judges: ReturnType<typeof listJudges>;
  recent: AuditRow[];
}

/** Everything on the organizer's live dashboard, in one read. */
export function eventProgress(store: Store, event: EventRow): Progress {
  const projects = store.get<Progress['projects']>(
    `SELECT
       count(*) FILTER (WHERE status = 'submitted' AND superseded_by IS NULL) AS submitted,
       count(*) FILTER (WHERE status = 'draft') AS drafts,
       count(*) FILTER (WHERE status = 'withdrawn') AS withdrawn,
       count(*) FILTER (WHERE superseded_by IS NOT NULL) AS replaced
     FROM projects WHERE event_id = ?`,
    [event.id],
  ) as Progress['projects'];

  const reviews = store.get<Progress['reviews']>(
    `SELECT count(*) AS assigned,
       count(*) FILTER (WHERE r.status = 'submitted') AS submitted,
       count(*) FILTER (WHERE r.status = 'draft') AS drafts,
       count(*) FILTER (WHERE r.status IS NULL) AS notStarted
     FROM assignments a JOIN projects p ON p.id = a.project_id LEFT JOIN reviews r ON r.assignment_id = a.id
     WHERE a.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL`,
    [event.id],
  ) as Progress['reviews'];

  const perProject = store.all<{ id: string; track_id: string | null; done: number }>(
    `SELECT p.id, p.track_id,
       (SELECT count(*) FROM assignments a JOIN reviews r ON r.assignment_id = a.id WHERE a.project_id = p.id AND r.status = 'submitted') AS done
     FROM projects p WHERE p.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL`,
    [event.id],
  );
  const target = event.reviews_per_project;
  const counts = new Map<number, number>();
  for (const p of perProject) counts.set(p.done, (counts.get(p.done) ?? 0) + 1);
  const histogram = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([reviews, n]) => ({ reviews, projects: n }));

  const judges = listJudges(store, event.id);
  const tracks = store.all<{ id: string; name: string }>('SELECT id, name FROM tracks WHERE event_id = ? ORDER BY position, name', [event.id]).map((track) => {
    const inTrack = perProject.filter((p) => p.track_id === track.id);
    return {
      id: track.id,
      name: track.name,
      projects: inTrack.length,
      reviews: inTrack.reduce((sum, p) => sum + p.done, 0),
      atTarget: inTrack.filter((p) => p.done >= target).length,
      judges: judges.filter((j) => j.trackIds.length === 0 || j.trackIds.includes(track.id)).length,
    };
  });

  return {
    projects,
    reviews,
    coverage: {
      target,
      atTarget: perProject.filter((p) => p.done >= target).length,
      below: perProject.filter((p) => p.done > 0 && p.done < target).length,
      none: perProject.filter((p) => p.done === 0).length,
      histogram,
    },
    tracks,
    judges,
    recent: listAudit(store, event.id, { limit: 8 }),
  };
}
