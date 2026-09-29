import { AccessDenied, myEventRoles, requireOrganizer } from '../domain/access.ts';
import { actorLabel } from '../domain/audit.ts';
import { eventCounts, getEvent, listCriteria, listEvents, listPrizes, listTracks, phaseOf } from '../domain/events.ts';
import { exportCsv } from '../domain/exports.ts';
import { judgeScores } from '../domain/judging.ts';
import { eventProgress } from '../domain/progress.ts';
import { gallery, projectPage } from '../domain/projects.ts';
import { publishedResults } from '../domain/results.ts';
import type { EventRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { badRequest, unauthorized } from '../util/errors.ts';

const publicEvent = (event: EventRow, now: Date) => ({
  id: event.id,
  slug: event.slug,
  name: event.name,
  tagline: event.tagline,
  description: event.description,
  phase: phaseOf(event, now).key,
  submissions_open_at: event.submissions_open_at,
  submissions_close_at: event.submissions_close_at,
  judging_close_at: event.judging_close_at,
  results_published_at: event.results_published_at,
  max_team_size: event.max_team_size,
  score_scale: [event.score_min, event.score_max],
});

export const apiRoutes: RouteModule = (router, { store }) => {
  router.get('/api', (ctx) => {
    ctx.json({
      name: 'Forgeboard API',
      auth: 'Send the session cookie from /login (POST email and password as JSON). Every rule the pages follow applies here too.',
      endpoints: {
        'GET /api/me': 'You, and your roles per event.',
        'GET /api/events': 'All events (public).',
        'GET /api/events/{id}': 'One event with tracks, prizes and rubric (public).',
        'GET /api/events/{id}/results': 'Published results (public once published).',
        'GET /api/events/{id}/progress': 'Judging progress (organizers).',
        'GET /api/projects?q=&event=&track=&sort=&page=': 'The public gallery.',
        'GET /api/projects/{id}': 'One project, if you may see it.',
        'POST /projects/new?event={id}': 'Create a project (JSON: title, summary, description, track_id, repo_url, demo_url, video_url, intent=draft|submit).',
        'POST /projects/{id}/edit': 'Update a project (same fields, plus version for conflict detection).',
        'GET /api/judge/scores[?judge=&event=]': 'Your own scores as a judge; another judge’s only as an organizer of their event.',
        'GET /api/export.csv?event={id}&kind=results|reviews|projects|judges|assignments|audit': 'CSV exports (organizers).',
      },
    });
  });

  router.get('/api/me', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const user = ctx.user;
    ctx.json({
      user: { id: user.id, name: user.name, email: user.email, admin: Boolean(user.is_admin) },
      events: myEventRoles(store, user.id).map(({ event, roles }) => ({ id: event.id, slug: event.slug, roles: [...roles] })),
    });
  });

  router.get('/api/events', (ctx) => {
    ctx.json({ events: listEvents(store).map((e) => ({ ...publicEvent(e, ctx.now), counts: eventCounts(store, e.id) })) });
  });

  router.get('/api/events/:id', (ctx) => {
    const event = getEvent(store, ctx.params.id as string);
    ctx.json({
      event: publicEvent(event, ctx.now),
      tracks: listTracks(store, event.id).map(({ id, name, description }) => ({ id, name, description })),
      prizes: listPrizes(store, event.id).map(({ id, name, description, track_id }) => ({ id, name, description, track_id })),
      rubric: listCriteria(store, event.id).map(({ key, name, description, weight }) => ({ key, name, description, weight })),
      counts: eventCounts(store, event.id),
    });
  });
};
