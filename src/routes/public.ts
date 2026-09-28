import { rolesIn } from '../domain/access.ts';
import { createEvent, eventCounts, getEvent, listEvents, listPrizes, listTracks, submissionsOpen } from '../domain/events.ts';
import { createProject, eventForSubmission, gallery, getProject, liveProjectOfTeam, projectPage, projectRevisions, updateProject, withdrawProject } from '../domain/projects.ts';
import { publishedResults } from '../domain/results.ts';
import { myTeam } from '../domain/teams.ts';
import type { EventRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import { forbidden, unauthorized, ValidationError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { eventFormPage } from '../views/organize.ts';
import { aboutPage, eventPage, eventsPage, galleryPage, landingPage, projectDetailPage, projectFormPage, resultsPage } from '../views/public.ts';

const text = (body: Body, key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');

export const publicRoutes: RouteModule = (router, { store }) => {
  router.get('/healthz', (ctx) => {
    const ok = store.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1;
    ctx.json({ status: ok ? 'ok' : 'degraded', time: ctx.now.toISOString() }, ok ? 200 : 503);
  });

  router.get('/', (ctx) => {
    const counts = store.get<{ events: number; projects: number; reviews: number; judges: number }>(
      `SELECT (SELECT count(*) FROM events) AS events,
         (SELECT count(*) FROM projects WHERE status = 'submitted' AND superseded_by IS NULL) AS projects,
         (SELECT count(*) FROM reviews WHERE status = 'submitted') AS reviews,
         (SELECT count(DISTINCT user_id) FROM event_roles WHERE role = 'judge') AS judges`,
    ) ?? { events: 0, projects: 0, reviews: 0, judges: 0 };
    ctx.html(landingPage(ctx, { counts, featured: listEvents(store)[0] ?? null }));
  });

  router.get('/about', (ctx) => ctx.html(aboutPage(ctx)));

  // Gallery: server-rendered, public, filterable by URL.
  router.get('/projects', (ctx) => {
    const sortParam = ctx.query('sort');
    const sort: 'newest' | 'title' | 'oldest' = sortParam === 'newest' || sortParam === 'title' ? sortParam : 'oldest';
    const query = { q: ctx.query('q') ?? '', event: ctx.query('event') ?? '', track: ctx.query('track') ?? '', sort };
    const result = gallery(store, { ...query, page: Number(ctx.query('page') ?? 1) || 1 });
    const events = listEvents(store);
    const scope = query.event ? events.filter((e) => e.slug === query.event || e.id === query.event) : events;
    const tracks = scope.flatMap((e) => listTracks(store, e.id).map((t) => ({ ...t, event_name: e.name })));
    ctx.html(galleryPage(ctx, { ...result, events, tracks, query }));
  });

  // New project. JSON clients (and the DOGFOOD checker) post here too.
  router.get('/projects/new', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const event = eventForSubmission(store, ctx.user, ctx.query('event'), ctx.now);
    const team = myTeam(store, ctx.user.id, event.id);
    if (!team) {
      ctx.flash('info', `Create or join a team for ${event.name} first.`);
      return ctx.redirect(`/events/${event.slug}/team`);
    }
    const existing = liveProjectOfTeam(store, team.id);
    if (existing) return ctx.redirect(`/projects/${existing.id}/edit`);
    if (!submissionsOpen(event, ctx.now)) throw forbidden(`Submissions for ${event.name} are closed.`);
    ctx.html(projectFormPage(ctx, { event, team, tracks: listTracks(store, event.id), values: {} }));
  });

  router.post('/projects/new', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await ctx.body();
    const event = eventForSubmission(store, ctx.user, ctx.query('event') ?? (text(body, 'event') || null), ctx.now);
    try {
      const project = createProject(store, ctx.actor, event, body);
      if (ctx.wantsJson) return ctx.json({ project }, 201);
      ctx.flash('success', project.status === 'submitted' ? 'Project submitted. You can keep editing until the deadline.' : 'Draft saved. Submit it before the deadline.');
      ctx.redirect(`/projects/${project.id}`);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      const team = myTeam(store, ctx.user.id, event.id);
      if (!team) throw error;
      ctx.html(projectFormPage(ctx, { event, team, tracks: listTracks(store, event.id), values: body as Record<string, string>, errors: error.fields }), 422);
    }
  });

  router.get('/projects/:id', (ctx) => {
    const view = projectPage(store, ctx.actor, ctx.params.id as string);
    const member = view.members.some((m) => m.id === ctx.user?.id);
    ctx.html(projectDetailPage(ctx, view, member || view.isOrganizer ? projectRevisions(store, view.project.id) : null));
  });
};
