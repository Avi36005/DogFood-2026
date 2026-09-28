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

