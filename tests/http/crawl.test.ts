import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startServer } from '../helpers.ts';
import { linksOf, seedScenario, type Cast } from '../qa-scenario.ts';

/**
 * Follows every link the portal shows, as every kind of person, and checks every page it
 * reaches. A link must never lead to a server error, a missing page, or a page that person is
 * not allowed to open; pages must not leak template values; every POST form must carry its
 * CSRF token; every field needs a label; element ids must be unique.
 */
describe('every link, as every role', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let cast: Cast;
  before(async () => {
    server = await startServer();
    cast = await seedScenario(server.url);
  });
  after(() => server.close());

  const START = ['/', '/dashboard', '/judge', '/organize', '/admin', '/account', '/events', '/projects'];
  const LEAKS = /\b(undefined|NaN|\[object Object\]|null)\b/;

  for (const role of ['anon', 'participant', 'judge_a', 'judge_b', 'organizer', 'admin', 'alice', 'bob', 'qaJudge']) {
    test(role, async () => {
      const client = cast.roles[role];
      assert.ok(client);
      const problems: string[] = [];
      const seen = new Set<string>();
      const from = new Map<string, string>();
      const queue = [...START];
      while (queue.length) {
        const url = queue.shift() as string;
        if (seen.has(url)) continue;
        seen.add(url);
        assert.ok(seen.size < 800, `${role}: the crawl did not converge (link loop?)`);
        const reply = await client.get(url);
        const origin = from.get(url);
        if (reply.status >= 500) problems.push(`${reply.status} on ${url}`);
        if (origin && [403, 404, 405].includes(reply.status)) problems.push(`${reply.status} on ${url}, linked from ${origin}`);
        if (!(reply.headers.get('content-type') ?? '').includes('text/html')) continue;

        const html = reply.text;
        const text = html.replace(/<[^>]+>/g, ' ');
        const leak = LEAKS.exec(text);
        if (leak) problems.push(`"${leak[1]}" rendered on ${url}`);
        for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
          if (/method="post"/i.test(form[1] ?? '') && !(form[2] ?? '').includes('name="_csrf"')) problems.push(`POST form without CSRF on ${url}`);
        }
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
        const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
        if (duplicate) problems.push(`duplicate id "${duplicate}" on ${url}`);
        for (const field of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
          const attrs = field[2] ?? '';
          if (/type="(hidden|submit|button|checkbox|radio)"/.test(attrs) || / hidden[\s>]/.test(`${attrs}>`)) continue;
          const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
          if (!/aria-label=/.test(attrs) && !(id && html.includes(`for="${id}"`))) problems.push(`unlabelled ${field[1]} on ${url}`);
        }
        for (const href of linksOf(html)) {
          if (!seen.has(href) && !from.has(href)) {
            from.set(href, url);
            queue.push(href);
          }
        }
      }
      assert.deepEqual(problems, [], `${role} visited ${seen.size} pages`);
    });
  }
});
