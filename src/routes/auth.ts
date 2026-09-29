import { myEventRoles } from '../domain/access.ts';
import { changePassword, findPasswordLink, signIn, signUp, usePasswordLink } from '../domain/accounts.ts';
import { record } from '../domain/audit.ts';
import { listEvents, submissionsOpen } from '../domain/events.ts';
import { liveProjectOfTeam } from '../domain/projects.ts';
import { createSession, destroySession, SESSION_DAYS } from '../domain/sessions.ts';
import { myTeam } from '../domain/teams.ts';
import type { UserRow } from '../domain/types.ts';
import type { RouteModule } from '../http/app.ts';
import { type Ctx, SESSION_COOKIE } from '../http/context.ts';
import { HttpError, unauthorized, ValidationError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { accountPage, dashboardPage, linkUsedPage, loginPage, passwordLinkPage, signupPage } from '../views/auth.ts';

const text = (body: Body, key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');

/** Starts a session and sets the cookie. A new token every time, so a planted cookie is useless. */
export function signInAs(ctx: Ctx, user: UserRow): void {
  const token = createSession(ctx.store, user.id, ctx.now);
  ctx.setCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 });
  ctx.user = user;
  ctx.sessionToken = token;
}

export const authRoutes: RouteModule = (router, { store, loginLimiter, signupLimiter }) => {
  router.get('/login', (ctx) => (ctx.user ? ctx.redirect(ctx.safeNext()) : ctx.html(loginPage(ctx))));

  router.post('/login', async (ctx) => {
    const body = await ctx.body();
    const email = text(body, 'email').trim().toLowerCase();
    const wait = loginLimiter.hit(`${ctx.ip}:${email}`);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    const user = await signIn(store, email, text(body, 'password'));
    if (!user) {
      record(store, ctx.actor, { action: 'account.sign_in_failed', summary: `A sign-in as ${email || '(blank)'} failed.` });
      if (ctx.wantsJson) throw new HttpError(401, 'Email or password is wrong.');
      return ctx.html(loginPage(ctx, { email }, 'Email or password is wrong.'), 401);
    }
    loginLimiter.reset(`${ctx.ip}:${email}`);
    signInAs(ctx, user);
    if (ctx.wantsJson) return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
    ctx.redirect(ctx.safeNext());
  });

  router.get('/signup', (ctx) => (ctx.user ? ctx.redirect(ctx.safeNext()) : ctx.html(signupPage(ctx))));

  router.post('/signup', async (ctx) => {
    const body = await ctx.body();
    if (signupLimiter.hit(ctx.ip)) throw new HttpError(429, 'Too many new accounts from this address. Try again later.');
    try {
      const user = await signUp(store, ctx.actor, body);
      signInAs(ctx, user);
      if (ctx.wantsJson) return ctx.json({ user: { id: user.id, name: user.name, email: user.email } }, 201);
      ctx.flash('success', `Welcome, ${user.name}.`);
      ctx.redirect(ctx.safeNext());
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      ctx.html(signupPage(ctx, { name: text(body, 'name'), email: text(body, 'email') }, error.fields), 422);
    }
  });

  router.post('/logout', (ctx) => {
    if (ctx.sessionToken) destroySession(store, ctx.sessionToken);
    ctx.clearCookie(SESSION_COOKIE);
    ctx.redirect('/');
  });

  // One-time links: account setup for imported people and first admins, and password resets.
  router.get('/password/:token', (ctx) => {
    const found = findPasswordLink(store, ctx.params.token as string, ctx.now);
    if (!found) return ctx.html(linkUsedPage(ctx, 'It has expired or has already been used. Ask an administrator for a new one.'), 410);
    ctx.html(passwordLinkPage(ctx, { user: found.user, purpose: found.link.purpose, action: `/password/${ctx.params.token}` }));
  });

  router.post('/password/:token', async (ctx) => {
    const body = await ctx.body();
    const token = ctx.params.token as string;
    try {
      const user = await usePasswordLink(store, ctx.actor, token, text(body, 'password'));
      signInAs(ctx, user);
      ctx.flash('success', 'Password saved. You are signed in.');
      ctx.redirect(user.is_admin ? '/admin' : '/dashboard');
    } catch (error) {
      if (!(error instanceof ValidationError) || ctx.wantsJson) throw error;
      const found = findPasswordLink(store, token, ctx.now);
      if (!found) throw error;
      ctx.html(passwordLinkPage(ctx, { user: found.user, purpose: found.link.purpose, action: `/password/${token}`, error: error.fields.password }), 422);
    }
  });

  router.get('/account', (ctx) => {
    if (!ctx.user) throw unauthorized();
    ctx.html(accountPage(ctx, ctx.user));
  });

  router.post('/account/password', async (ctx) => {
    if (!ctx.user || !ctx.sessionToken) throw unauthorized();
    try {
      await changePassword(store, ctx.actor, ctx.user, await ctx.body(), ctx.sessionToken);
      ctx.flash('success', 'Password changed. Your other sessions were signed out.');
      ctx.redirect('/account');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      ctx.html(accountPage(ctx, ctx.user, error.fields), 422);
    }
  });

  router.get('/dashboard', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const user = ctx.user;
    const entries = myEventRoles(store, user.id).map(({ event, roles }) => {
      const team = myTeam(store, user.id, event.id) ?? null;
      const queue = roles.has('judge')
        ? (store.get<{ total: number; submitted: number }>(
            `SELECT count(*) AS total, count(r.assignment_id) FILTER (WHERE r.status = 'submitted') AS submitted
             FROM assignments a LEFT JOIN reviews r ON r.assignment_id = a.id WHERE a.event_id = ? AND a.judge_id = ?`,
            [event.id, user.id],
          ) ?? null)
        : null;
      return { event, roles, team, project: team ? (liveProjectOfTeam(store, team.id) ?? null) : null, queue };
    });
    ctx.html(dashboardPage(ctx, entries, listEvents(store).filter((e) => submissionsOpen(e, ctx.now))));
  });
};
