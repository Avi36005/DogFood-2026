import type { Ctx } from './context.ts';

export type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export type Match = { handler: Handler; params: Record<string, string> } | { allowed: string[] } | null;

/** Method plus path, with :name segments. Small on purpose: the whole route table fits on one screen. */
export class Router {
  readonly #routes: Route[] = [];

  get(path: string, handler: Handler): this {
    return this.#add('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.#add('POST', path, handler);
  }

  #add(method: string, path: string, handler: Handler): this {
    this.#routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }

  match(method: string, pathname: string): Match {
    const segments = pathname.split('/').filter(Boolean);
    const lookup = method === 'HEAD' ? 'GET' : method;
    const allowed: string[] = [];
    for (const route of this.#routes) {
      const params = matchParts(route.parts, segments);
      if (!params) continue;
      if (route.method === lookup) return { handler: route.handler, params };
      allowed.push(route.method);
    }
    return allowed.length ? { allowed } : null;
  }
}

function matchParts(parts: string[], segments: string[]): Record<string, string> | null {
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const segment = segments[i] as string;
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return null;
      }
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}
