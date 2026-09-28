import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { start } from '../../src/server.ts';
import { Client, FIXTURES, isoIn } from '../helpers.ts';
import { linksOf, seedScenario } from '../qa-scenario.ts';

/**
 * Presses every button the portal shows, as every kind of person, in three stages of an event.
 * Each press runs on a fresh copy of the same seeded database, so no press depends on another.
 * The form is filled the way a person would: existing values kept, empty fields given plausible
 * values, the clicked button's name and value sent.
 *
 * Guarantees: no press causes a server error, and no button is shown that must fail. A 403 or
 * a 409 would mean the page offered someone an action they cannot take. The only refusals
 * allowed are field validation (422) and a sign-in with made-up credentials (401).
 */
interface Press { role: string; page: string; action: string; method: string; index: number; button: { name: string; value: string; label: string } | null; key: string }

const configFor = (dir: string) => loadConfig({
  FORGEBOARD_DB_PATH: path.join(dir, 'qa.db'), FORGEBOARD_FIXTURES: FIXTURES, FORGEBOARD_DEMO: '1',
  FORGEBOARD_SEED_FIXTURES: '1', FORGEBOARD_PORT: '0', FORGEBOARD_HOST: '127.0.0.1', FORGEBOARD_QUIET: '1',
});

/** Collapses ids so one of each kind of button is pressed: /tracks/trk_x/remove and /tracks/trk_y/remove are the same button. */
const kind = (action: string) =>
  (action.split('?')[0] ?? '')
    .replace(/\/(join|judge-invite|password)\/[\w-]+/, '/$1/:token')
    .replace(/\b(prj|asg|usr|jdg|trk|prz|tm|crt|res)_\w+/g, ':$1');

function fillValue(name: string, type: string, password: string, n: number): string {
  if (type === 'email' || name.includes('email')) return `pressed+${n}@example.com`;
  if (name === 'current_password') return password;
  if (type === 'password' || name.includes('password')) return 'pressed-password-1';
  if (type === 'url' || name.endsWith('_url')) return 'https://example.org/pressed';
  if (type === 'datetime-local') return isoIn(240);
  if (type === 'number') return '2';
  if (type === 'search' || name === 'q') return '';
  return `Pressed ${name}`;
}

function formData(html: string, button: Press['button'], password: string, n: number): URLSearchParams {
  const data = new URLSearchParams();
  const radios = new Map<string, { value: string; checked: boolean }[]>();
  const decode = (v: string) => v.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    if (!name || /readonly/.test(attrs)) continue;
    const type = /type="([^"]+)"/.exec(attrs)?.[1] ?? 'text';
    const value = decode(/value="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const checked = / checked/.test(attrs);
    if (type === 'checkbox') { if (checked) data.append(name, value); continue; }
    if (type === 'radio') { radios.set(name, [...(radios.get(name) ?? []), { value, checked }]); continue; }
    data.append(name, value || (type === 'hidden' ? '' : fillValue(name, type, password, n)));
  }
  for (const [name, options] of radios) data.append(name, (options.find((o) => o.checked) ?? options[Math.floor(options.length / 2)])?.value ?? '');
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /name="([^"]+)"/.exec(m[1] ?? '')?.[1];
    const options = [...(m[2] ?? '').matchAll(/<option value="([^"]*)"( selected)?/g)];
    if (name) data.append(name, (options.find((o) => o[2]) ?? options.find((o) => o[1]))?.[1] ?? '');
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = /name="([^"]+)"/.exec(m[1] ?? '')?.[1];
    if (name) data.append(name, decode((m[2] ?? '').trim()) || (name === 'tracks' ? 'One\nTwo' : `Pressed ${name}`));
  }
  if (button?.name) data.set(button.name, button.value);
  return data;
}

for (const stage of ['open', 'judging', 'published'] as const) {
  describe(`every button, event stage "${stage}"`, () => {
    test('no button causes an error or offers an action that must fail', async () => {
      // Seed once, then snapshot the database directory.
      const template = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-buttons-'));
      let running = await start(configFor(template));
      const cast = await seedScenario(running.url, stage);

      const presses: Press[] = [];
      const keys = new Set<string>();
      for (const [role, client] of Object.entries(cast.roles)) {
        const seen = new Set<string>();
        const queue = ['/', '/dashboard', '/judge', '/organize', '/admin', '/account', '/events', '/projects', '/login', '/signup', cast.joinLink, '/events/qa-open/team'];
        while (queue.length) {
          const url = queue.shift() as string;
          if (seen.has(url)) continue;
          seen.add(url);
          const reply = await client.get(url);
          if (!(reply.headers.get('content-type') ?? '').includes('text/html')) continue;
          [...reply.text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].forEach((m, index) => {
            const attrs = m[1] ?? '';
            const method = (/method="(\w+)"/i.exec(attrs)?.[1] ?? 'get').toUpperCase();
            const action = (/action="([^"]*)"/.exec(attrs)?.[1] ?? url).replaceAll('&amp;', '&');
            const buttons = [...(m[2] ?? '').matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
              .filter((b) => !/type="button"/.test(b[1] ?? ''))
              .map((b) => ({ name: /name="([^"]+)"/.exec(b[1] ?? '')?.[1] ?? '', value: /value="([^"]*)"/.exec(b[1] ?? '')?.[1] ?? '', label: (b[2] ?? '').replace(/<[^>]+>/g, '').trim() }));
            for (const button of buttons.length ? buttons : [null]) {
              const key = `${role} ${method} ${kind(action)} [${button?.label ?? 'no button'}]`;
              if (keys.has(key)) continue;
              keys.add(key);
              presses.push({ role, page: url, action, method, index, button, key });
            }
          });
          for (const href of linksOf(reply.text)) {
            if (href.startsWith('/api/') || /^\/(login|signup)\?/.test(href)) continue;
            if (/^\/projects\/prj_\d\d$/.test(href) && !/prj_(01|07|41)$/.test(href)) continue; // three fixture projects stand for all
            if (!seen.has(href)) queue.push(href);
          }
        }
      }
      await running.close();

      const outcomes: string[] = [];
      let n = 0;
      for (const press of presses) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-press-'));
        for (const file of fs.readdirSync(template)) fs.copyFileSync(path.join(template, file), path.join(dir, file));
        running = await start(configFor(dir));
        const client = new Client(running.url);
        for (const [name, value] of cast.roles[press.role]?.cookies ?? []) client.cookies.set(name, value);
        const page = await client.get(press.page);
        const form = [...page.text.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)][press.index]?.[1] ?? '';
        const data = formData(form, press.button, cast.passwords[press.role] ?? '', n++);
        const reply = press.method === 'POST'
          ? await client.request('POST', press.action, { body: data.toString(), type: 'application/x-www-form-urlencoded' })
          : await client.get(`${press.action.split('?')[0]}?${data}`);
        const allowed = reply.status < 400 || reply.status === 422 || (reply.status === 401 && press.action.startsWith('/login'));
        if (!allowed) outcomes.push(`${reply.status} ${press.key} (on ${press.page})`);
        await running.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.rmSync(template, { recursive: true, force: true });

      assert.ok(presses.length > 60, `only ${presses.length} buttons found`);
      assert.deepEqual(outcomes, [], `pressed ${presses.length} buttons`);
    });
  });
}
