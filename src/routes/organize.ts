import { myEventRoles, requireOrganizer } from '../domain/access.ts';
import { auditActions, listAudit } from '../domain/audit.ts';
import { addOrganizer, addPrize, addTrack, closeSubmissionsNow, getEvent, listCriteria, listOrganizers, listPrizes, listTracks, removePrize, removeTrack, updateEvent } from '../domain/events.ts';
import { assignManually, autoAssign, inviteJudge, listAssignments, listJudges, removeJudge, setJudgeTracks, unassign } from '../domain/judging.ts';
import { eventProgress } from '../domain/progress.ts';
import { chooseLiveSubmission, duplicateGroups, eventProjects } from '../domain/projects.ts';
import { computeStandings, listSnapshots, publishResults, unpublishResults } from '../domain/results.ts';
import { rubricLocked, saveRubric } from '../domain/rubric.ts';
import type { EventRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { unauthorized, ValidationError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { assignmentsPage, auditPage, exportPage, judgesPage, organizeHomePage, overviewPage, progressFragment, projectsAdminPage, resultsAdminPage, rubricPage, settingsPage, type OverviewView } from '../views/organize.ts';

export const organizeRoutes: RouteModule = (router, { store, config }) => {
  /** The one gate for every organizer page: the event, and proof the caller organizes it. */
  const organizerEvent = (ctx: Ctx, attempted: string): EventRow => {
    const event = getEvent(store, ctx.params.slug as string);
    requireOrganizer(store, ctx.actor, event, attempted);
    return event;
  };

  const overview = (event: EventRow): OverviewView => ({
    event,
    progress: eventProgress(store, event),
    flags: computeStandings(store, event).judges.filter((j) => j.flags.length).map((j) => ({ judge: j.judge_id, name: j.name, flags: j.flags })),
    duplicates: duplicateGroups(store, event.id).length,
    rubricReady: listCriteria(store, event.id).length > 0,
  });

  /** Runs a form action; on a validation error, re-renders the page with the field messages. */
  const act = async (ctx: Ctx, run: (body: Body) => void, success: string, back: string, rerender: (errors: Record<string, string>, body: Body) => void) => {
    const body = await ctx.body();
    try {
      run(body);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      return rerender(error.fields, body);
    }
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.flash('success', success);
    ctx.redirect(back);
  };

  router.get('/organize', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const events = myEventRoles(store, ctx.user.id).filter((e) => e.roles.has('organizer')).map((e) => e.event);
    if (events.length === 1 && events[0]) return ctx.redirect(`/organize/${events[0].slug}`);
    ctx.html(organizeHomePage(ctx, events));
  });

  router.get('/organize/:slug', (ctx) => {
    const event = organizerEvent(ctx, 'open the organizer overview');
    ctx.html(overviewPage(ctx, overview(event)));
  });

  // The live part of the overview, fetched every few seconds by app.js.
  router.get('/organize/:slug/progress', (ctx) => {
    const event = organizerEvent(ctx, 'read judging progress');
    ctx.send(200, 'text/html; charset=utf-8', progressFragment(ctx, overview(event)).value);
  });

  router.post('/organize/:slug/close-submissions', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    closeSubmissionsNow(store, ctx.actor, event);
    ctx.flash('success', 'Submissions are closed. Judging can start.');
    ctx.redirect(`/organize/${event.slug}`);
  });

  // Settings, tracks, prizes, organizers.
  /** A track with projects cannot be removed, so the page shows the count instead of the button. */
  const tracksWithCounts = (event: EventRow) => {
    const counts = new Map(store.all<{ track_id: string; n: number }>('SELECT track_id, count(*) AS n FROM projects WHERE event_id = ? GROUP BY track_id', [event.id]).map((r) => [r.track_id, r.n]));
    return listTracks(store, event.id).map((t) => ({ ...t, projects: counts.get(t.id) ?? 0 }));
  };
  const renderSettings = (ctx: Ctx, event: EventRow, extra: { values?: Record<string, string>; errors?: Record<string, string> } = {}, status = 200) =>
    ctx.html(settingsPage(ctx, { event, tracks: tracksWithCounts(event), prizes: listPrizes(store, event.id), organizers: listOrganizers(store, event.id), ...extra }), status);

  router.get('/organize/:slug/settings', (ctx) => renderSettings(ctx, organizerEvent(ctx, 'open event settings')));

  router.post('/organize/:slug/settings', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    await act(ctx, (body) => updateEvent(store, ctx.actor, event, body), 'Settings saved.', `/organize/${event.slug}/settings`, (errors, body) =>
      renderSettings(ctx, event, { errors, values: body as Record<string, string> }, 422));
  });

  router.post('/organize/:slug/tracks', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    await act(ctx, (body) => addTrack(store, ctx.actor, event, body), 'Track added.', `/organize/${event.slug}/settings`, (errors) => renderSettings(ctx, event, { errors }, 422));
  });

  router.post('/organize/:slug/tracks/:id/remove', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    removeTrack(store, ctx.actor, event, ctx.params.id as string);
    ctx.flash('success', 'Track removed.');
    ctx.redirect(`/organize/${event.slug}/settings`);
  });

  router.post('/organize/:slug/prizes', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    await act(ctx, (body) => addPrize(store, ctx.actor, event, body), 'Prize added.', `/organize/${event.slug}/settings`, (errors) => renderSettings(ctx, event, { errors }, 422));
  });

  router.post('/organize/:slug/prizes/:id/remove', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    removePrize(store, ctx.actor, event, ctx.params.id as string);
    ctx.flash('success', 'Prize removed.');
    ctx.redirect(`/organize/${event.slug}/settings`);
  });

  router.post('/organize/:slug/organizers', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    await act(ctx, (body) => addOrganizer(store, ctx.actor, event, typeof body.email === 'string' ? body.email : ''), 'Organizer added.', `/organize/${event.slug}/settings`, (errors) =>
      renderSettings(ctx, event, { errors }, 422));
  });

  // Rubric.
  router.get('/organize/:slug/rubric', (ctx) => {
    const event = organizerEvent(ctx, 'open the rubric');
    ctx.html(rubricPage(ctx, event, listCriteria(store, event.id), rubricLocked(store, event.id)));
  });

  router.post('/organize/:slug/rubric', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    await act(ctx, (body) => saveRubric(store, ctx.actor, event, body), 'Rubric saved.', `/organize/${event.slug}/rubric`, (errors) =>
      ctx.html(rubricPage(ctx, event, listCriteria(store, event.id), rubricLocked(store, event.id), errors), 422));
  });

  // Judges.
  router.get('/organize/:slug/judges', (ctx) => {
    const event = organizerEvent(ctx, 'open the judge list');
    ctx.html(judgesPage(ctx, { event, judges: listJudges(store, event.id), tracks: listTracks(store, event.id) }));
  });

  router.post('/organize/:slug/judges', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const body = await ctx.body();
    try {
      const { user, token } = inviteJudge(store, ctx.actor, event, body);
      const url = `${config.publicUrl}/judge-invite/${token}`;
      if (ctx.wantsJson) return ctx.json({ judge: { id: user.id, email: user.email }, invite_url: url }, 201);
      ctx.html(judgesPage(ctx, { event, judges: listJudges(store, event.id), tracks: listTracks(store, event.id), inviteLink: { email: user.email, url } }), 201);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      ctx.html(judgesPage(ctx, { event, judges: listJudges(store, event.id), tracks: listTracks(store, event.id), errors: error.fields, values: body as Record<string, string | string[]> }), 422);
    }
  });

  router.post('/organize/:slug/judges/:id/tracks', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    setJudgeTracks(store, ctx.actor, event, ctx.params.id as string, await ctx.body());
    ctx.flash('success', 'Tracks updated.');
    ctx.redirect(`/organize/${event.slug}/judges`);
  });

  router.post('/organize/:slug/judges/:id/remove', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    removeJudge(store, ctx.actor, event, ctx.params.id as string);
    ctx.flash('success', 'Judge removed.');
    ctx.redirect(`/organize/${event.slug}/judges`);
  });

  // Assignments.
  const renderAssignments = (ctx: Ctx, event: EventRow, extra: { created?: number; shortfalls?: { title: string; have: number; missing: number; reason: string }[]; errors?: Record<string, string> } = {}, status = 200) =>
    ctx.html(assignmentsPage(ctx, {
      event,
      assignments: listAssignments(store, event.id),
      projects: eventProjects(store, event.id),
      judges: listJudges(store, event.id).map((j) => ({ id: j.id, name: j.name })),
      created: extra.created ?? null,
      shortfalls: extra.shortfalls ?? null,
      errors: extra.errors,
    }), status);

  router.get('/organize/:slug/assignments', (ctx) => renderAssignments(ctx, organizerEvent(ctx, 'open assignments')));

  router.post('/organize/:slug/assignments/auto', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const result = autoAssign(store, ctx.actor, event);
    if (ctx.wantsJson) return ctx.json(result);
    renderAssignments(ctx, event, result);
  });
};
