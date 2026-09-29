import { rolesIn } from '../domain/access.ts';
import { createEvent, eventCounts, getEvent, listEvents, listPrizes, listTracks, submissionsOpen } from '../domain/events.ts';
import { createProject, eventForSubmission, gallery, getProject, liveProjectOfTeam, projectPage, projectRevisions, updateProject, withdrawProject } from '../domain/projects.ts';
import { listComments } from '../domain/comments.ts';
import { currentEvidence, type ResultsDocument } from '../domain/evidence.ts';
import { votePhase, voteSettings } from '../domain/voting.ts';
import { publishedResults } from '../domain/results.ts';
import { verifyText } from '../domain/signing.ts';
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
    const isPublic = view.project.status === 'submitted' && !view.project.superseded_by;
    ctx.html(projectDetailPage(ctx, view, member || view.isOrganizer ? projectRevisions(store, view.project.id) : null, isPublic ? listComments(store, ctx.actor, view.project) : null));
  });

  router.get('/projects/:id/edit', (ctx) => {
    const view = projectPage(store, ctx.actor, ctx.params.id as string);
    if (!ctx.user) throw unauthorized();
    if (!view.members.some((m) => m.id === ctx.user?.id)) throw forbidden('Only members of the team can edit this project.');
    if (!view.canEdit) throw forbidden(submissionsOpen(view.event, ctx.now) ? 'This project can no longer be edited.' : `Submissions for ${view.event.name} are closed.`);
    const p = view.project;
    ctx.html(projectFormPage(ctx, {
      event: view.event,
      team: view.team,
      tracks: listTracks(store, view.event.id),
      values: { title: p.title, summary: p.summary, description: p.description, track_id: p.track_id ?? '', repo_url: p.repo_url, demo_url: p.demo_url, video_url: p.video_url },
      projectId: p.id,
      status: p.status,
      version: p.version,
    }));
  });

  router.post('/projects/:id/edit', async (ctx) => {
    const body = await ctx.body();
    try {
      const wasDraft = getProject(store, ctx.params.id as string).status === 'draft';
      const project = updateProject(store, ctx.actor, ctx.params.id as string, body);
      if (ctx.wantsJson) return ctx.json({ project });
      ctx.flash('success', project.status !== 'submitted'
        ? 'Draft saved.'
        : wasDraft
          ? 'Project submitted. You can keep editing until the deadline.'
          : 'Saved. Your submission is up to date.');
      ctx.redirect(`/projects/${project.id}`);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      const project = getProject(store, ctx.params.id as string);
      const event = getEvent(store, project.event_id);
      const team = myTeam(store, ctx.user?.id ?? '', event.id);
      if (!team) throw error;
      ctx.html(projectFormPage(ctx, { event, team, tracks: listTracks(store, event.id), values: body as Record<string, string>, errors: error.fields, projectId: project.id, status: project.status, version: project.version }), 422);
    }
  });

  router.post('/projects/:id/withdraw', (ctx) => {
    withdrawProject(store, ctx.actor, ctx.params.id as string);
    const project = getProject(store, ctx.params.id as string);
    ctx.flash('info', `“${project.title}” was withdrawn.`);
    ctx.redirect(`/events/${getEvent(store, project.event_id).slug}/team`);
  });

  // Events.
  router.get('/events', (ctx) => {
    const events = listEvents(store).map((e) => ({ ...e, ...eventCounts(store, e.id) }));
    ctx.html(eventsPage(ctx, events, Boolean(ctx.user?.is_admin)));
  });

  router.get('/events/new', (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (!ctx.user.is_admin) throw forbidden('Only an administrator can create events.');
    ctx.html(eventFormPage(ctx, { values: { max_team_size: '4', reviews_per_project: '3' } }));
  });

  router.post('/events/new', async (ctx) => {
    const body = await ctx.body();
    try {
      const event = createEvent(store, ctx.actor, body);
      if (ctx.wantsJson) return ctx.json({ event }, 201);
      ctx.flash('success', `${event.name} is live. Add prizes, check the rubric, then invite judges.`);
      ctx.redirect(`/organize/${event.slug}`);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      ctx.html(eventFormPage(ctx, { values: body as Record<string, string>, errors: error.fields }), 422);
    }
  });

  router.get('/events/:slug', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    ctx.html(eventPage(ctx, {
      event,
      tracks: listTracks(store, event.id),
      prizes: listPrizes(store, event.id),
      counts: eventCounts(store, event.id),
      roles: ctx.user ? rolesIn(store, ctx.user.id, event.id) : new Set(),
      team: ctx.user ? (myTeam(store, ctx.user.id, event.id) ?? null) : null,
      published: Boolean(event.results_published_at),
      vote: votePhase(voteSettings(store, event.id), ctx.now),
    }));
  });

  router.get('/events/:slug/results', (ctx) => {
    const event: EventRow = getEvent(store, ctx.params.slug as string);
    const isOrganizer = ctx.user ? rolesIn(store, ctx.user.id, event.id).has('organizer') : false;
    const evidence = currentEvidence(store, event);
    ctx.html(resultsPage(ctx, event, publishedResults(store, event), isOrganizer, evidence ? { signed: verifyText(evidence.documentText, evidence.signature, evidence.publicKey), document: JSON.parse(evidence.documentText) as ResultsDocument } : null));
  });

  // The signed results document. Anyone can check the signature with the public key it carries;
  // the per-review inputs stay with the organizer (they ship in the results capsule).
  router.get('/events/:slug/results.json', (ctx) => {
    const event: EventRow = getEvent(store, ctx.params.slug as string);
    const evidence = currentEvidence(store, event);
    if (!evidence) return ctx.json({ published: false, message: 'Results are hidden until the organizers publish them.' }, 404);
    ctx.json({
      published: true,
      signature_algorithm: 'Ed25519',
      public_key: evidence.publicKey,
      signature: evidence.signature,
      document_text: evidence.documentText,
      document: JSON.parse(evidence.documentText),
      how_to_verify: 'The signature is over the UTF-8 bytes of document_text, exactly as given. Save this response and run: node src/cli.ts verify-results <file>. The organizer\'s results capsule adds the inputs and refits the ranking in a browser.',
    });
  });
};
