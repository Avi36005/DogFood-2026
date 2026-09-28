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
}
