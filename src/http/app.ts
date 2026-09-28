import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { AccessDenied } from '../domain/access.ts';
import { record } from '../domain/audit.ts';
import { findSessionUser } from '../domain/sessions.ts';
import { HttpError, ValidationError } from '../util/errors.ts';
import { registerAsset } from '../views/assets.ts';
import { errorPage } from '../views/errors.ts';
import { Ctx, SESSION_COOKIE } from './context.ts';
import { RateLimiter } from './rate-limit.ts';
import { Router } from './router.ts';
import { loadStatic } from './static.ts';

export interface AppDeps {
  store: Store;
  config: Config;
  secret: string;
  /** Sign-in attempts per IP and email: strict, because guesses target one account. */
  loginLimiter: RateLimiter;
  /** New accounts per IP: loose, because a whole venue can share one address at kickoff. */
  signupLimiter: RateLimiter;
}

export type RouteModule = (router: Router, deps: AppDeps) => void;

const SECURITY_HEADERS: Record<string, string> = {
  // No inline script or style anywhere, so the policy can be strict.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp(store: Store, config: Config, secret: string, modules: RouteModule[]): (req: IncomingMessage, res: ServerResponse) => void {
  const deps: AppDeps = {
    store,
    config,
    secret,
    loginLimiter: new RateLimiter(10, 10 * 60_000),
    signupLimiter: new RateLimiter(100, 10 * 60_000),
  };
  const router = new Router();
  for (const register of modules) register(router, deps);
  const files = loadStatic();
  for (const [name, file] of files) registerAsset(name, file.hash);

  return (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const ctx = new Ctx(req, res, store, config, secret);
    handle(ctx, router, files).catch((error: unknown) => fail(ctx, error));
  };
}

async function handle(ctx: Ctx, router: Router, files: ReturnType<typeof loadStatic>): Promise<void> {
  const path = ctx.url.pathname;
  if (path.startsWith('/static/') && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
    const file = files.get(path.slice('/static/'.length));
    if (!file) throw new HttpError(404, 'No such file.');
    const cache = ctx.url.searchParams.get('v') === file.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    ctx.send(200, file.type, file.body, { 'Cache-Control': cache, ETag: `"${file.hash}"` });
    return;
  }
  if (path === '/favicon.ico') return ctx.redirect('/static/favicon.svg', 301);

  const token = ctx.cookie(SESSION_COOKIE);
  if (token) {
    ctx.user = findSessionUser(ctx.store, token, ctx.now);
    if (ctx.user) ctx.sessionToken = token;
  }

  const match = router.match(ctx.method, path);
  if (!match) throw new HttpError(404, 'There is nothing at this address.');
  if ('allowed' in match) {
    ctx.res.setHeader('Allow', [...new Set(match.allowed)].join(', '));
    throw new HttpError(405, `${ctx.method} is not supported here.`);
  }
  if (UNSAFE.has(ctx.method)) await ctx.verifyCsrf();
  ctx.params = match.params;
  await match.handler(ctx);
  if (!ctx.res.headersSent) throw new Error(`handler for ${ctx.method} ${path} sent no response`);
}

function fail(ctx: Ctx, error: unknown): void {
  // Refusals are recorded here, after any transaction has rolled back, so they always persist.
  if (error instanceof AccessDenied) {
    try {
      record(ctx.store, ctx.actor, error.audit);
    } catch (auditError) {
      console.error('could not record an access denial', auditError);
    }
  }
  let status = 500;
  let message = 'Something went wrong on our side. The error has been logged.';
  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof Error && /constraint failed/.test(error.message)) {
    // A constraint caught what the code did not: report it as a conflict, not a crash.
    status = 409;
    message = 'That change conflicts with existing data, so nothing was saved.';
    console.error(`${ctx.method} ${ctx.url.pathname}:`, error.message);
  } else {
    console.error(`${ctx.method} ${ctx.url.pathname}:`, error);
  }
  if (ctx.res.headersSent) return;

  if (ctx.wantsJson) {
    const body: Record<string, unknown> = { error: message, status };
    if (error instanceof ValidationError) body.fields = error.fields;
    ctx.json(body, status);
    return;
  }
  if (status === 401 && ctx.method === 'GET') {
    ctx.redirect(`/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    return;
  }
  ctx.html(errorPage(ctx, status, message, error instanceof ValidationError ? error.fields : undefined), status);
}
