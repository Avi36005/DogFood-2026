import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Actor, UserRow } from '../domain/types.ts';
import { HttpError } from '../util/errors.ts';
import type { Body } from '../util/form.ts';
import { hmac, newToken, safeEqual } from '../util/tokens.ts';
import type { SafeHtml } from '../views/html.ts';

export const SESSION_COOKIE = 'session';
const CSRF_COOKIE = 'csrf';
const FLASH_COOKIE = 'flash';
const MAX_BODY_BYTES = 1024 * 1024;

export interface Flash {
  kind: 'success' | 'error' | 'info';
  text: string;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      if (!cookies.has(name)) cookies.set(name, decodeURIComponent(value));
    } catch {
      // A malformed cookie is ignored, not fatal.
    }
  }
  return cookies;
}

/** Everything a handler needs about one request, and the ways to answer it. */
export class Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method: string;
  readonly store: Store;
  readonly config: Config;
  readonly now = new Date();
  params: Record<string, string> = {};
  user: UserRow | null = null;
  sessionToken: string | null = null;
  readonly #secret: string;
  readonly #cookies: Map<string, string>;
  readonly #setCookies: string[] = [];
  #body: Promise<Body> | null = null;
  #csrfCookie: string;

  constructor(req: IncomingMessage, res: ServerResponse, store: Store, config: Config, secret: string) {
    this.req = req;
    this.res = res;
    this.store = store;
    this.config = config;
    this.#secret = secret;
    this.method = (req.method ?? 'GET').toUpperCase();
    this.url = new URL(req.url ?? '/', 'http://localhost');
    this.#cookies = parseCookies(req.headers.cookie);
    const csrf = this.#cookies.get(CSRF_COOKIE);
    if (csrf && /^[\w-]{20,100}$/.test(csrf)) {
      this.#csrfCookie = csrf;
    } else {
      this.#csrfCookie = newToken();
      this.setCookie(CSRF_COOKIE, this.#csrfCookie, { httpOnly: true });
    }
  }

  /** The client's address, for rate limits and the audit trail. X-Forwarded-For is trusted only when configured. */
  get ip(): string {
    const forwarded = this.config.trustProxy ? this.req.headers['x-forwarded-for'] : undefined;
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first || this.req.socket.remoteAddress || 'unknown';
  }

  get actor(): Actor {
    return { user: this.user, ip: this.ip, now: this.now };
  }

  query(name: string): string | null {
    const value = this.url.searchParams.get(name);
    return value === null || value === '' ? null : value;
  }

  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  setCookie(name: string, value: string, options: CookieOptions = {}): void {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
    if (options.httpOnly !== false) parts.push('HttpOnly');
    if (this.config.cookieSecure) parts.push('Secure');
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    this.#setCookies.push(parts.join('; '));
  }

  clearCookie(name: string): void {
    this.setCookie(name, '', { maxAge: 0 });
  }

  /** Where JSON beats HTML: the API, or a client that says it wants JSON. */
  get wantsJson(): boolean {
    if (this.url.pathname.startsWith('/api/')) return true;
    const accept = this.req.headers.accept ?? '';
    const type = this.req.headers['content-type'] ?? '';
    return type.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
  }

  get isJsonBody(): boolean {
    return (this.req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json';
  }

  // CSRF ------------------------------------------------------------------------

  /** The per-browser token that every form carries as _csrf. */
  get csrfToken(): string {
    return hmac(this.#secret, this.#csrfCookie);
  }

  /**
   * Unsafe requests must come from our own pages. Three layers: the session cookie is
   * SameSite=Lax; a browser's Origin header must be ours; and a form body must carry the
   * token. A JSON body needs no token, because a cross-site page cannot send one without a
   * CORS preflight, which this server never approves.
   */
  async verifyCsrf(): Promise<void> {
    const origin = this.req.headers.origin;
    if (origin && origin !== 'null') {
      const host = this.req.headers.host;
      const allowed = new Set([new URL(this.config.publicUrl).origin, `http://${host}`, `https://${host}`]);
      if (!allowed.has(origin)) throw new HttpError(403, 'This request came from another site and was refused.');
    }
    if (this.isJsonBody) return;
    const body = await this.body();
    const token = typeof body._csrf === 'string' ? body._csrf : '';
    if (!safeEqual(token, this.csrfToken)) throw new HttpError(403, 'This form has expired. Reload the page and try again.');
  }

  // Bodies ----------------------------------------------------------------------

  body(): Promise<Body> {
    this.#body ??= this.#readBody();
    return this.#body;
  }

  async #readBody(): Promise<Body> {
    if (this.method === 'GET' || this.method === 'HEAD') return {};
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request body is too large.');
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const type = (this.req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (text === '') return {};
    if (type === 'application/json') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        return parsed as Body;
      } catch {
        throw new HttpError(400, 'The body is not a JSON object.');
      }
    }
    if (type === 'application/x-www-form-urlencoded' || type === '') {
      const body: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(text)) {
        const existing = body[key];
        if (existing === undefined) body[key] = value;
        else body[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
      return body;
    }
    throw new HttpError(415, 'Send application/x-www-form-urlencoded or application/json.');
  }

  // Flash messages ------------------------------------------------------------------

  flash(kind: Flash['kind'], text: string): void {
    this.#flashed = { kind, text };
    if (this.wantsJson) return; // a JSON caller gets the message in the response body instead
    this.setCookie(FLASH_COOKIE, JSON.stringify({ kind, text }), { maxAge: 60 });
  }

  #flashed: Flash | null = null;

  takeFlash(): Flash | null {
    const raw = this.#cookies.get(FLASH_COOKIE);
    if (!raw) return null;
    this.clearCookie(FLASH_COOKIE);
    try {
      const value = JSON.parse(raw) as Flash;
      if (['success', 'error', 'info'].includes(value.kind) && typeof value.text === 'string') return { kind: value.kind, text: value.text.slice(0, 500) };
    } catch {
      // ignore a tampered or truncated flash
    }
    return null;
  }

  // Responses -----------------------------------------------------------------------

  send(status: number, contentType: string, body: string | Buffer, headers: Record<string, string> = {}): void {
    if (this.res.headersSent) return;
    this.res.statusCode = status;
    this.res.setHeader('Content-Type', contentType);
    if (!this.res.hasHeader('Cache-Control')) this.res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) this.res.setHeader(name, value);
    if (this.#setCookies.length) this.res.setHeader('Set-Cookie', this.#setCookies);
    this.res.end(body);
  }

  html(page: SafeHtml, status = 200): void {
    this.send(status, 'text/html; charset=utf-8', page.value);
  }

  json(data: unknown, status = 200): void {
    this.send(status, 'application/json; charset=utf-8', `${JSON.stringify(data, null, 2)}\n`);
  }

  csv(filename: string, body: string): void {
    this.send(200, 'text/csv; charset=utf-8', body, { 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"` });
  }

  /**
   * After a form action a browser follows the redirect. A script that sent JSON gets JSON
   * instead: the action is done, here is what the page would have said and where it would go.
   * This is what makes every form in the UI an API call as well (see /api/openapi.json).
   */
  redirect(location: string, status = 303): void {
    if (status === 303 && this.method !== 'GET' && this.wantsJson) {
      const flash = this.#flashed;
      this.json({ ok: flash?.kind !== 'error', location, ...(flash ? { message: flash.text } : {}) });
      return;
    }
    this.send(status, 'text/plain; charset=utf-8', `Redirecting to ${location}`, { Location: location });
  }

  /** Only same-site paths, so ?next= cannot be turned into an open redirect. */
  safeNext(fallback = '/dashboard'): string {
    const next = this.query('next');
    return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : fallback;
  }
}
