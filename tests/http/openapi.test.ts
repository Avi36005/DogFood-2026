import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { RateLimiter } from '../../src/http/rate-limit.ts';
import { Router } from '../../src/http/router.ts';
import { openApiDocument } from '../../src/routes/openapi.ts';
import { ROUTE_MODULES } from '../../src/server.ts';
import { Client, startServer } from '../helpers.ts';
import { linksOf, seedScenario, type Cast } from '../qa-scenario.ts';

/**
 * API first, checked rather than claimed: the OpenAPI document is held to the router's own route
 * table, and to every form the UI renders as every role. A route added without documentation, a
 * documented route that does not exist, or a form field the document does not describe fails here.
 */

interface Operation { operationId: string; summary: string; security?: unknown[]; responses: Record<string, unknown>; requestBody?: { content: { 'application/json': { schema: { properties?: Record<string, unknown>; patternProperties?: Record<string, unknown> } } } } }
type Doc = { openapi: string; paths: Record<string, Record<string, Operation>> };

const doc = openApiDocument() as unknown as Doc;
const routes = (() => {
  const router = new Router();
  const limiter = () => new RateLimiter(1000, 60_000);
  const deps = { store: null as never, config: loadConfig({}), secret: 'x', loginLimiter: limiter(), signupLimiter: limiter(), codeLimiter: limiter(), ballotLimiter: limiter(), commentLimiter: limiter() };
  for (const register of ROUTE_MODULES) register(router, deps);
  return router.list();
})();
const openApiPath = (path: string) => path.replace(/:([a-z]+)/g, '{$1}');
/** What the document must cover: every action (POST), the JSON reads, and the signed results. */
const API_ROUTES = routes.filter((r) => r.method === 'POST' || r.path.startsWith('/api/') || r.path === '/api' || /results\.json$|capsule\.html$/.test(r.path));
const operation = (method: string, path: string) => doc.paths[openApiPath(path)]?.[method.toLowerCase()];

describe('the OpenAPI document', () => {
  test('is OpenAPI 3.1 with a unique operationId, a summary and responses on every operation', () => {
    assert.equal(doc.openapi, '3.1.0');
    const seen = new Set<string>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        assert.ok(op.operationId && !seen.has(op.operationId), `${method} ${path}: operationId ${op.operationId}`);
        seen.add(op.operationId);
        assert.ok(op.summary, `${method} ${path}: summary`);
        assert.ok(Object.keys(op.responses).length > 0, `${method} ${path}: responses`);
      }
    }
  });

  test(`covers all ${API_ROUTES.filter((r) => r.method === 'POST').length} actions the router accepts`, () => {
    assert.ok(API_ROUTES.filter((r) => r.method === 'POST').length >= 44);
  });

  for (const route of API_ROUTES) {
    test(`documents ${route.method} ${route.path}`, () => {
      assert.ok(operation(route.method, route.path), `${route.method} ${openApiPath(route.path)} is not in /api/openapi.json`);
    });
  }

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      test(`${method.toUpperCase()} ${path} exists in the router`, () => {
        assert.ok(routes.some((r) => r.method === method.toUpperCase() && openApiPath(r.path) === path), 'documented but not routed');
      });
    }
  }
});

describe('served, and answering as documented', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  test('GET /api/openapi.json serves the same document, and /api points to it', async () => {
    const anon = new Client(server.url);
    const reply = await anon.getJson('/api/openapi.json');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json(), JSON.parse(JSON.stringify(doc)));
    assert.equal((await anon.getJson('/api')).json<{ openapi: string }>().openapi, '/api/openapi.json');
  });

  for (const url of ['/api/events', '/api/events/evt_01', '/api/events/evt_01/results', '/api/events/evt_01/vote', '/api/projects', '/api/projects/prj_01']) {
    test(`GET ${url} is public JSON, as documented`, async () => {
      const reply = await new Client(server.url).getJson(url);
      assert.equal(reply.status, 200);
      assert.match(reply.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(operation('GET', url.replace(/evt_01/, ':id').replace(/prj_01/, ':id'))?.security?.length ?? 0, 0);
    });
  }

  test('a form action called with JSON answers JSON, not a redirect, and the change is real', async () => {
    const organizer = Client.as(server.url, 'organizer');
    const reply = await organizer.request('POST', '/organize/sample-hack-2026/tracks', { body: JSON.stringify({ name: 'Robotics' }), type: 'application/json', headers: { accept: 'application/json' } });
    assert.equal(reply.status, 200);
    const body = reply.json<{ ok: boolean; location: string; message?: string }>();
    assert.equal(body.ok, true);
    assert.match(body.location, /^\/organize\/sample-hack-2026/);
    assert.equal(reply.headers.get('set-cookie')?.includes('flash') ?? false, false, 'no flash cookie for a script');
    const event = (await organizer.getJson('/api/events/evt_01')).json<{ tracks: { name: string }[] }>();
    assert.ok(event.tracks.some((t) => t.name === 'Robotics'));
  });

  test('the same action refused is a JSON 403, and nothing changes', async () => {
    const reply = await Client.as(server.url, 'judge_a').request('POST', '/organize/sample-hack-2026/tracks', { body: JSON.stringify({ name: 'Sneaky' }), type: 'application/json', headers: { accept: 'application/json' } });
    assert.equal(reply.status, 403);
    assert.equal(reply.json<{ status: number }>().status, 403);
    const event = (await new Client(server.url).getJson('/api/events/evt_01')).json<{ tracks: { name: string }[] }>();
    assert.ok(!event.tracks.some((t) => t.name === 'Sneaky'));
  });

  test('a browser posting the form still gets the redirect', async () => {
    const organizer = Client.as(server.url, 'organizer');
    const reply = await organizer.postForm('/organize/sample-hack-2026/tracks', { name: 'Form track' }, { tokenFrom: '/organize/sample-hack-2026/settings' });
    assert.equal(reply.status, 303);
  });
});

describe('every form the UI renders is a documented API call', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let cast: Cast;
  before(async () => {
    server = await startServer();
    cast = await seedScenario(server.url);
  });
  after(() => server.close());

  const patterns = routes.filter((r) => r.method === 'POST').map((r) => ({ path: r.path, rx: new RegExp(`^${r.path.replace(/:[a-z]+/g, '[^/]+')}$`) }));

  for (const role of ['anon', 'participant', 'judge_a', 'judge_b', 'organizer', 'admin', 'alice', 'bob', 'qaJudge']) {
    test(`as ${role}: each form posts to a documented operation that describes all its fields`, async () => {
      const client = cast.roles[role];
      assert.ok(client);
      const problems: string[] = [];
      const seen = new Set<string>();
      const queue = ['/', '/dashboard', '/judge', '/organize', '/admin', '/account', '/events', '/projects', '/login', '/signup'];
      let forms = 0;
      while (queue.length) {
        const url = queue.shift() as string;
        if (seen.has(url)) continue;
        seen.add(url);
        const reply = await client.get(url);
        if (!(reply.headers.get('content-type') ?? '').includes('text/html')) continue;
        for (const form of reply.text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
          if (!/method="post"/i.test(form[1] ?? '')) continue;
          forms++;
          const action = (/action="([^"]*)"/.exec(form[1] ?? '')?.[1] ?? url).replace(/&amp;/g, '&').split('?')[0] as string;
          const route = patterns.find((p) => p.rx.test(action));
          if (!route) { problems.push(`${url}: form posts to ${action}, which no route accepts`); continue; }
          const op = operation('POST', route.path);
          if (!op) { problems.push(`${url}: POST ${route.path} is not documented`); continue; }
          const schema = op.requestBody?.content['application/json'].schema;
          for (const name of new Set([...(form[2] ?? '').matchAll(/\bname="([^"]+)"/g)].map((m) => m[1] as string))) {
            if (name === '_csrf') continue;
            const described = Boolean(schema?.properties?.[name]) || Object.keys(schema?.patternProperties ?? {}).some((p) => new RegExp(p).test(name));
            if (!described) problems.push(`${url}: field "${name}" of POST ${route.path} is not in the document`);
          }
        }
        for (const href of linksOf(reply.text)) if (!seen.has(href)) queue.push(href);
      }
      assert.deepEqual(problems, [], `${role}: ${forms} forms on ${seen.size} pages`);
    });
  }
});
