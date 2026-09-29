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

  router.get('/api/events/:id/results', (ctx) => {
    const event = getEvent(store, ctx.params.id as string);
    const results = publishedResults(store, event);
    if (!results) return ctx.json({ published: false, message: 'Results are hidden until the organizers publish them.' });
    ctx.json({ published: true, snapshot: results.snapshot, rows: results.rows });
  });

  router.get('/api/events/:id/progress', (ctx) => {
    const event = getEvent(store, ctx.params.id as string);
    requireOrganizer(store, ctx.actor, event, 'read judging progress through the API');
    ctx.json(eventProgress(store, event));
  });

  router.get('/api/projects', (ctx) => {
    const sort = ctx.query('sort');
    const result = gallery(store, {
      q: ctx.query('q') ?? undefined,
      event: ctx.query('event') ?? undefined,
      track: ctx.query('track') ?? undefined,
      sort: sort === 'newest' || sort === 'title' ? sort : 'oldest',
      page: Number(ctx.query('page') ?? 1) || 1,
    });
    ctx.json({
      ...result,
      items: result.items.map((p) => ({
        id: p.id, title: p.title, summary: p.summary, team: p.team_name, track: p.track_name, event: p.event_slug,
        repo_url: p.repo_url, demo_url: p.demo_url, video_url: p.video_url, submitted_at: p.submitted_at, rank: p.rank,
      })),
    });
  });

  router.get('/api/projects/:id', (ctx) => {
    const view = projectPage(store, ctx.actor, ctx.params.id as string);
    ctx.json({ project: view.project, team: { id: view.team.id, name: view.team.name, members: view.members.map((m) => m.name) }, track: view.track?.name ?? null, event: view.event.slug });
  });

  router.get('/api/judge/scores', (ctx) => {
    ctx.json(judgeScores(store, ctx.actor, { judge: ctx.query('judge'), event: ctx.query('event') }));
  });

  /** CSV for organizers. Without ?event= it uses the one event the caller organizes. */
  router.get('/api/export.csv', (ctx: Ctx) => {
    if (!ctx.user) throw unauthorized();
    const user = ctx.user;
    let eventRef = ctx.query('event');
    if (!eventRef) {
      const organized = myEventRoles(store, user.id).filter((e) => e.roles.has('organizer'));
      if (organized.length > 1) throw badRequest(`You organize ${organized.length} events; say which with ?event=<id>.`);
      if (!organized[0]) {
        throw new AccessDenied('Only organizers can export data.', {
          eventId: myEventRoles(store, user.id)[0]?.event.id ?? null,
          action: 'access.denied',
          subjectType: 'export',
          summary: `${actorLabel(ctx.actor)} was refused a CSV export (they organize no event).`,
        });
      }
      eventRef = organized[0].event.id;
    }
    const event = getEvent(store, eventRef);
    const { filename, body } = exportCsv(store, ctx.actor, event, ctx.query('kind') ?? 'results');
    ctx.csv(filename, body);
  });
};
