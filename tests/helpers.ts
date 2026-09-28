import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { DEMO_SESSIONS } from '../src/domain/demo.ts';
import { start, type Running } from '../src/server.ts';

export const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures.json');
export const DEMO_PASSWORD = 'forgeboard-demo';
export { DEMO_SESSIONS };

/**
 * A real server on a random port with a throwaway database. Tests never touch ./data or any
 * running instance: every server gets its own temporary directory, removed on close.
 */
export async function startServer(options: { demo?: boolean } = {}): Promise<Running & { dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-test-'));
  const config = loadConfig({
    FORGEBOARD_DB_PATH: path.join(dir, 'test.db'),
    FORGEBOARD_FIXTURES: FIXTURES,
    FORGEBOARD_DEMO: options.demo === false ? '0' : '1',
    FORGEBOARD_SEED_FIXTURES: '1',
    FORGEBOARD_PORT: '0',
    FORGEBOARD_HOST: '127.0.0.1',
    FORGEBOARD_QUIET: '1',
  });
  const running = await start(config);
  return {
    ...running,
    dir,
    close: async () => {
      await running.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

/** A browser-like client: keeps cookies, reads the CSRF token from pages, never follows redirects. */
export class Client {
  readonly base: string;
  readonly cookies = new Map<string, string>();

  constructor(base: string, session?: string) {
    this.base = base;
    if (session) this.cookies.set('session', session);
  }

  static as(base: string, role: keyof typeof DEMO_SESSIONS): Client {
    return new Client(base, DEMO_SESSIONS[role]);
  }

  async request(method: string, url: string, init: { body?: string; type?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (init.type) headers['content-type'] = init.type;
    const response = await fetch(this.base + url, { method, headers, body: init.body, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = decodeURIComponent((pair ?? '').slice(index + 1));
      if (/Max-Age=0/.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: <T>() => JSON.parse(text) as T };
  }

  get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
    return this.request('GET', url, { headers });
  }

  getJson(url: string): Promise<Reply> {
    return this.request('GET', url, { headers: { accept: 'application/json' } });
  }

  postJson(url: string, data: unknown): Promise<Reply> {
    return this.request('POST', url, { body: JSON.stringify(data), type: 'application/json' });
  }

  /** Loads a page to get a CSRF token (like a browser rendering the form), then posts the form. */
  async postForm(url: string, data: Record<string, string | string[]>, options: { tokenFrom?: string; csrf?: boolean } = {}): Promise<Reply> {
    const form = new URLSearchParams();
    if (options.csrf !== false) form.set('_csrf', await this.csrfToken(options.tokenFrom));
    for (const [key, value] of Object.entries(data)) {
      for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
    }
    return this.request('POST', url, { body: form.toString(), type: 'application/x-www-form-urlencoded' });
  }

  /** Signed-in pages carry the token in the sign-out form; anonymous ones on the sign-in form. */
  async csrfToken(from?: string): Promise<string> {
    for (const url of from ? [from] : ['/about', '/login']) {
      const token = /name="_csrf" value="([^"]+)"/.exec((await this.get(url)).text)?.[1];
      if (token) return token;
    }
    throw new Error('no CSRF token found');
  }

  async signIn(email: string, password = DEMO_PASSWORD): Promise<Reply> {
    return this.postForm('/login', { email, password }, { tokenFrom: '/login' });
  }
}

/** The first match of a pattern in a page, or a clear failure. */
export function extract(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`pattern ${pattern} not found`);
  return match[1];
}

export function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);
}
