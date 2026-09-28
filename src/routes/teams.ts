import { rolesIn } from '../domain/access.ts';
import { getEvent } from '../domain/events.ts';
import { liveProjectOfTeam } from '../domain/projects.ts';
import { createTeam, findInvite, joinTeam, leaveTeam, myTeam, regenerateInvite, teamMembers } from '../domain/teams.ts';
import type { EventRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import type { Ctx } from '../http/context.ts';
import { unauthorized, ValidationError } from '../util/errors.ts';
import { linkUsedPage } from '../views/auth.ts';
import { joinPage, teamPage } from '../views/teams.ts';

export const teamRoutes: RouteModule = (router, { store, config }) => {
  const render = (ctx: Ctx, event: EventRow, extra: { inviteToken?: string; errors?: Record<string, string>; values?: Record<string, string> } = {}, status = 200) => {
    if (!ctx.user) throw unauthorized();
    const team = myTeam(store, ctx.user.id, event.id) ?? null;
    const members = team ? teamMembers(store, team.id) : [];
    const roles = rolesIn(store, ctx.user.id, event.id);
    ctx.html(teamPage(ctx, {
      event,
      team,
      members,
      project: team ? (liveProjectOfTeam(store, team.id) ?? null) : null,
      inviteLink: extra.inviteToken ? `${config.publicUrl}/join/${extra.inviteToken}` : null,
      isCaptain: members.some((m) => m.id === ctx.user?.id && m.is_captain),
      blockedReason: roles.has('judge') || roles.has('organizer') ? `You ${roles.has('judge') ? 'judge' : 'organize'} ${event.name}, so you cannot be on a team in it.` : null,
      errors: extra.errors,
      values: extra.values,
    }), status);
  };

  router.get('/events/:slug/team', (ctx) => render(ctx, getEvent(store, ctx.params.slug as string)));

  router.post('/events/:slug/team', async (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    const body = await ctx.body();
    try {
      const { team, inviteToken } = createTeam(store, ctx.actor, event, body);
      if (ctx.wantsJson) return ctx.json({ team, invite_url: `${config.publicUrl}/join/${inviteToken}` }, 201);
      render(ctx, event, { inviteToken }, 201);
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      render(ctx, event, { errors: error.fields, values: body as Record<string, string> }, 422);
    }
  });

  router.post('/events/:slug/team/invite', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const event = getEvent(store, ctx.params.slug as string);
    const team = myTeam(store, ctx.user.id, event.id);
    if (!team) return ctx.redirect(`/events/${event.slug}/team`);
    const inviteToken = regenerateInvite(store, ctx.actor, team);
    if (ctx.wantsJson) return ctx.json({ invite_url: `${config.publicUrl}/join/${inviteToken}` });
    render(ctx, event, { inviteToken });
  });

  router.post('/events/:slug/team/leave', (ctx) => {
    const event = getEvent(store, ctx.params.slug as string);
    leaveTeam(store, ctx.actor, event);
    ctx.flash('info', 'You left the team.');
    ctx.redirect(`/events/${event.slug}/team`);
  });

  router.get('/join/:token', (ctx) => {
    const invite = findInvite(store, ctx.params.token as string, ctx.now);
    if (!invite) return ctx.html(linkUsedPage(ctx, 'This invite link has expired or was replaced. Ask the team captain for a new one.'), 410);
    const roles = ctx.user ? rolesIn(store, ctx.user.id, invite.event.id) : new Set();
    const blocked = roles.has('judge') || roles.has('organizer') ? `You ${roles.has('judge') ? 'judge' : 'organize'} ${invite.event.name}, so you cannot be on a team in it.` : null;
    ctx.html(joinPage(ctx, invite, ctx.user ? (myTeam(store, ctx.user.id, invite.event.id) ?? null) : null, blocked));
  });

  router.post('/join/:token', (ctx) => {
    const team = joinTeam(store, ctx.actor, ctx.params.token as string);
    const event = getEvent(store, team.event_id);
    ctx.flash('success', `You joined ${team.name}.`);
    ctx.redirect(`/events/${event.slug}/team`);
  });
};
