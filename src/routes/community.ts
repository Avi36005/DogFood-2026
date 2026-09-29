import { AccessDenied, requireOrganizer, rolesIn } from '../domain/access.ts';
import { addComment, hideComment } from '../domain/comments.ts';
import { getEvent } from '../domain/events.ts';
import type { EventRow } from '../domain/types.ts';
import {
  ballotChoices, ballotClusters, castBallot, codeBatches, computeTally, createVoterCodes, existingBallot, publishVote,
  resolveVoter, saveVoteSettings, visibleTally, voidBallot, votePhase, voteSettings, type VoteSettings,
} from '../domain/voting.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { HttpError, unauthorized, ValidationError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { votePage, voteResultsPage, votingAdminPage, type VotingAdminView } from '../views/community.ts';
import { organizerPage } from '../views/organize.ts';

/** The public tier: community voting and comments. Every rule lives in domain/voting.ts and domain/comments.ts. */
export const communityRoutes: RouteModule = (router, { store, secret, codeLimiter, ballotLimiter, commentLimiter }) => {
  const limit = (key: string, limiter: typeof codeLimiter) => {
    const wait = limiter.hit(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
  };

  // The ballot page: what this visitor may do right now.
  router.get('/events/:slug/vote', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const settings = voteSettings(store, event.id);
    const phase = votePhase(settings, ctx.now);
    if (!settings) return ctx.html(votePage(ctx, event, { kind: 'off' }));
    if (phase !== 'open') return ctx.html(votePage(ctx, event, { kind: phase === 'off' ? 'closed' : phase, settings }));
    if (settings.access === 'codes') return ctx.html(votePage(ctx, event, { kind: 'code', settings }));
    if (!ctx.user) return ctx.html(votePage(ctx, event, { kind: 'sign-in', settings }));
    try {
      const voter = resolveVoter(store, ctx.actor, event, settings, null);
      const cast = existingBallot(store, event.id, voter);
      if (cast) return ctx.html(votePage(ctx, event, { kind: 'cast', settings, castAt: cast.cast_at }));
      ctx.html(votePage(ctx, event, { kind: 'ballot', settings, choices: ballotChoices(store, event, voter, secret), code: null }));
    } catch (error) {
      // Viewing the page is not an attempt; the refusal is audited when a ballot is posted.
      if (!(error instanceof AccessDenied)) throw error;
      ctx.html(votePage(ctx, event, { kind: 'ineligible', settings, reason: error.message }));
    }
  });

  // A voter code opens a ballot. Only wrong codes count against an address, so a venue sharing
  // one address can vote freely while a guesser is stopped. A wrong or spent code gets the same
  // answer, so nothing is learned from a miss.
  const refuseIfGuessing = (ctx: Ctx) => {
    const wait = codeLimiter.waiting(`code:${ctx.ip}`);
    if (wait) throw new HttpError(429, `Too many wrong codes from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`);
  };
  const countWrongCode = (ctx: Ctx) => codeLimiter.hit(`code:${ctx.ip}`);

  router.post('/events/:slug/vote/code', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const settings = openCodeVote(ctx, event);
    refuseIfGuessing(ctx);
    const body = await ctx.body();
    const code = String(body.code ?? '');
    try {
      const voter = resolveVoter(store, ctx.actor, event, settings, code);
      ctx.html(votePage(ctx, event, { kind: 'ballot', settings, choices: ballotChoices(store, event, voter, secret), code }));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      countWrongCode(ctx);
      ctx.html(votePage(ctx, event, { kind: 'code', settings, error: error.fields.code }), 422);
    }
  });

  router.post('/events/:slug/vote', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    limit(`ballot:${ctx.ip}`, ballotLimiter);
    refuseIfGuessing(ctx);
    const body = await ctx.body();
    try {
      const { ballotId, picks } = castBallot(store, ctx.actor, event, body, secret, { userAgent: String(ctx.req.headers['user-agent'] ?? '') });
      if (ctx.wantsJson) return ctx.json({ ballot: ballotId, picks });
      const settings = voteSettings(store, event.id) as VoteSettings;
      ctx.html(votePage(ctx, event, { kind: 'cast', settings, castAt: ctx.now.toISOString() }));
    } catch (error) {
      if (error instanceof ValidationError && error.fields.code) countWrongCode(ctx);
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      rerenderBallot(ctx, event, body, error);
    }
  });

  const rerenderBallot = (ctx: Ctx, event: EventRow, body: Body, error: ValidationError) => {
    const settings = voteSettings(store, event.id) as VoteSettings;
    const code = settings.access === 'codes' ? String(body.code ?? '') : null;
    if (error.fields.code) return ctx.html(votePage(ctx, event, { kind: 'code', settings, error: error.fields.code }), 422);
    const voter = resolveVoter(store, ctx.actor, event, settings, code);
    const picked = Array.isArray(body.pick) ? body.pick.filter((p): p is string => typeof p === 'string') : typeof body.pick === 'string' ? [body.pick] : [];
    ctx.html(votePage(ctx, event, { kind: 'ballot', settings, choices: ballotChoices(store, event, voter, secret), code, picked, error: error.fields.pick ?? error.message }), 422);
  };

  const openCodeVote = (ctx: Ctx, event: EventRow): VoteSettings => {
    const settings = voteSettings(store, event.id);
    if (!settings || settings.access !== 'codes') throw new HttpError(404, 'This vote does not use voter codes.');
    if (votePhase(settings, ctx.now) !== 'open') throw new HttpError(409, 'Voting is not open.');
    return settings;
  };

  router.get('/events/:slug/vote/results', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const settings = voteSettings(store, event.id);
    const isOrganizer = ctx.user ? rolesIn(store, ctx.user.id, event.id).has('organizer') : false;
    ctx.html(voteResultsPage(ctx, event, settings, votePhase(settings, ctx.now), visibleTally(store, ctx.actor, event), isOrganizer));
  });

  router.get('/api/events/:id/vote', (ctx) => {
    const event = getEvent(store, ctx.params.id as string);
    const settings = voteSettings(store, event.id);
    const tally = visibleTally(store, ctx.actor, event);
    ctx.json({
      phase: votePhase(settings, ctx.now),
      settings: settings && { opens_at: settings.opens_at, closes_at: settings.closes_at, access: settings.access, max_picks: settings.max_picks, published_at: settings.published_at },
      tally: tally ?? null,
      ...(tally ? {} : { message: 'The tally is hidden until voting has closed and the organizers publish it.' }),
    });
  });

  // The organizer's tab.
  const adminView = (ctx: Ctx, event: EventRow, extra: Partial<VotingAdminView> = {}): VotingAdminView => {
    const settings = voteSettings(store, event.id);
    return {
      event,
      settings,
      phase: votePhase(settings, ctx.now),
      tally: settings ? computeTally(store, event.id) : null,
      clusters: ballotClusters(store, event.id),
      batches: codeBatches(store, event.id),
      ...extra,
    };
  };
  const renderAdmin = (ctx: Ctx, event: EventRow, extra: Partial<VotingAdminView> = {}, status = 200) =>
    ctx.html(votingAdminPage(ctx, adminView(ctx, event, extra), (body, lead) => organizerPage(ctx, event, 'voting', 'Community vote', body, { lead })), status);
  const organizerEvent = (ctx: Ctx, attempted: string): EventRow => {
    const event = getEvent(store, ctx.params.slug as string);
    requireOrganizer(store, ctx.actor, event, attempted);
    return event;
  };

  router.get('/organize/:slug/voting', (ctx) => renderAdmin(ctx, organizerEvent(ctx, 'open the community vote')));

  router.post('/organize/:slug/voting', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const body = await ctx.body();
    try {
      saveVoteSettings(store, ctx.actor, event, body);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      return renderAdmin(ctx, event, { values: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])), errors: error.fields }, 422);
    }
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.flash('success', 'Community vote saved.');
    ctx.redirect(`/organize/${event.slug}/voting`);
  });

  // Codes are shown once, in this response, and never again: only their hashes are stored.
  router.post('/organize/:slug/voting/codes', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const body = await ctx.body();
    const created = createVoterCodes(store, ctx.actor, event, Number(body.count));
    if (ctx.wantsJson) return ctx.json(created);
    renderAdmin(ctx, event, { newCodes: created });
  });

  router.post('/organize/:slug/voting/ballots/:id/void', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    voidBallot(store, ctx.actor, event, ctx.params.id as string, await ctx.body());
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.flash('info', `Ballot ${ctx.params.id} voided. It stays on record.`);
    ctx.redirect(`/organize/${event.slug}/voting`);
  });

  router.post('/organize/:slug/voting/publish', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    publishVote(store, ctx.actor, event);
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.flash('success', 'The community vote is published.');
    ctx.redirect(`/organize/${event.slug}/voting`);
  });

  // Comments.
  router.post('/projects/:id/comments', async (ctx) => {
    if (!ctx.user) throw unauthorized('Sign in to comment.');
    limit(`comment:${ctx.user.id}`, commentLimiter);
    const projectId = ctx.params.id as string;
    try {
      const id = addComment(store, ctx.actor, projectId, await ctx.body());
      if (ctx.wantsJson) return ctx.json({ comment: id });
      ctx.redirect(`/projects/${projectId}#${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      ctx.flash('error', error.fields.body ?? error.message);
      ctx.redirect(`/projects/${projectId}#comments`);
    }
  });

  router.post('/comments/:id/hide', async (ctx) => {
    const project = hideComment(store, ctx.actor, ctx.params.id as string, await ctx.body());
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.flash('info', 'The comment is taken down. It stays on record for the organizers.');
    ctx.redirect(`/projects/${project.id}#comments`);
  });
};
