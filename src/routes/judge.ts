import { myEventRoles } from '../domain/access.ts';
import { compareView, recordChoice } from '../domain/compare.ts';
import { getEvent } from '../domain/events.ts';
import { acceptJudgeInvite, claimJudgeInvite, findJudgeInvite, judgeQueue, reviewPage, saveReview } from '../domain/judging.ts';
import type { RouteModule } from '../http/app.ts';
import { unauthorized, ValidationError } from '../util/errors.ts';
import { linkUsedPage, passwordLinkPage } from '../views/auth.ts';
import { comparePage } from '../views/compare.ts';
import { judgeHomePage, judgeInviteAcceptPage, queuePage, reviewFormPage } from '../views/judge.ts';
import { signInAs } from './auth.ts';

export const judgeRoutes: RouteModule = (router, { store }) => {
  router.get('/judge', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const events = myEventRoles(store, ctx.user.id)
      .filter((entry) => entry.roles.has('judge'))
      .map(({ event }) => ({
        ...event,
        ...(store.get<{ total: number; submitted: number }>(
          `SELECT count(*) AS total, count(r.assignment_id) FILTER (WHERE r.status = 'submitted') AS submitted
           FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id WHERE a.event_id = ? AND a.judge_id = ?`,
          [event.id, ctx.user?.id ?? ''],
        ) ?? { total: 0, submitted: 0 }),
      }));
    if (events.length === 1 && events[0]) return ctx.redirect(`/judge/${events[0].slug}`);
    ctx.html(judgeHomePage(ctx, events));
  });

  router.get('/judge/:slug', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    ctx.html(queuePage(ctx, event, judgeQueue(store, ctx.actor, event)));
  });

  router.get('/judge/:slug/compare', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    ctx.html(comparePage(ctx, compareView(store, ctx.actor, event)));
  });

  router.post('/judge/:slug/compare', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    recordChoice(store, ctx.actor, event, await ctx.body());
    if (ctx.wantsJson) return ctx.json({ ok: true });
    ctx.redirect(`/judge/${event.slug}/compare`);
  });

  router.get('/judge/reviews/:id', (ctx) => {
    ctx.html(reviewFormPage(ctx, reviewPage(store, ctx.actor, ctx.params.id as string)));
  });

  router.post('/judge/reviews/:id', async (ctx) => {
    const id = ctx.params.id as string;
    const body = await ctx.body();
    try {
      const result = saveReview(store, ctx.actor, id, body);
      if (ctx.wantsJson) return ctx.json(result);
      const view = reviewPage(store, ctx.actor, id);
      const next = judgeQueue(store, ctx.actor, view.event).find((i) => i.review_status !== 'submitted' && !i.replaced && i.assignment_id !== id);
      ctx.flash('success', result.submitted ? `Review of “${view.project.title}” saved as submitted.` : `Draft of “${view.project.title}” saved.`);
      ctx.redirect(result.submitted && next ? `/judge/reviews/${next.assignment_id}` : `/judge/${view.event.slug}`);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      ctx.html(reviewFormPage(ctx, reviewPage(store, ctx.actor, id), { errors: error.fields, values: body as Record<string, string> }), 422);
    }
  });

  router.get('/judge-invite/:token', (ctx) => {
    const invite = findJudgeInvite(store, ctx.params.token as string, ctx.now);
    if (!invite) return ctx.html(linkUsedPage(ctx, 'This invitation has expired or was already accepted. Ask the organizer for a new one.'), 410);
    if (!invite.user.password_hash) {
      return ctx.html(passwordLinkPage(ctx, { user: invite.user, purpose: 'judge', eventName: invite.event.name, action: ctx.url.pathname }));
    }
    ctx.html(judgeInviteAcceptPage(ctx, invite.event, invite.user));
  });

  router.post('/judge-invite/:token', async (ctx) => {
    const token = ctx.params.token as string;
    const invite = findJudgeInvite(store, token, ctx.now);
    if (!invite) return ctx.html(linkUsedPage(ctx, 'This invitation has expired or was already accepted.'), 410);
    if (!invite.user.password_hash) {
      const body = await ctx.body();
      try {
        const user = await claimJudgeInvite(store, ctx.actor, token, typeof body.password === 'string' ? body.password : '');
        signInAs(ctx, user);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return ctx.html(passwordLinkPage(ctx, { user: invite.user, purpose: 'judge', eventName: invite.event.name, action: ctx.url.pathname, error: error.fields.password }), 422);
      }
    } else {
      acceptJudgeInvite(store, ctx.actor, token);
    }
    ctx.flash('success', `Welcome to the judging panel of ${invite.event.name}.`);
    ctx.redirect(`/judge/${invite.event.slug}`);
  });
};
