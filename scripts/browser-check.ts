/**
 * Checks what only a real browser can: forms submitted by clicking, the phone menu, copy
 * buttons, two-step confirms, the live dashboard refresh, keyboard scoring, and that no page
 * logs a JavaScript or console error. Drives headless Chrome over the DevTools protocol, with
 * no dependencies, against a throwaway server.
 *
 *   npm run check:browser                       (Chrome at the usual macOS or Linux path)
 *   CHROME=/path/to/chrome npm run check:browser
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, isoIn, startServer } from '../tests/helpers.ts';

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));
const chromePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('No Chrome or Chromium found. Set CHROME=/path/to/chrome.');
  process.exit(2);
}

const server = await startServer();
const base = server.url;
const admin = new Client(base);
await admin.signIn('admin@forgeboard.local');
await admin.postForm('/events/new', { name: 'QA Open', submissions_close_at: isoIn(120), tracks: 'Alpha\nBeta' });

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeboard-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
for (let i = 0; i < 100 && !targets.length; i++) {
  try {
    targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as typeof targets;
  } catch {
    await sleep(100);
  }
}
const target = targets.find((t) => t.type === 'page');
if (!target) throw new Error('Chrome did not start');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));

let nextId = 0;
const pending = new Map<number, (message: { error?: { message: string }; result?: any }) => void>();
const events: { method: string; params: any }[] = [];
const errors: string[] = [];
socket.addEventListener('message', (e) => {
  const message = JSON.parse(String(e.data));
  if (message.id) return pending.get(message.id)?.(message);
  events.push(message);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
});
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
const loaded = async () => {
  for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await sleep(50);
  await sleep(150);
};
const go = async (url: string) => {
  events.length = 0;
  await send('Page.navigate', { url: base + url });
  await loaded();
};
const click = async (selector: string) => {
  events.length = 0;
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await loaded();
};
const key = (k: string, code: number) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code });
const viewport = (width: number, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });

const results: [string, boolean][] = [];
const check = (name: string, ok: unknown) => results.push([name, Boolean(ok)]);
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Log.enable');

try {
  await viewport(1280);
  await go('/login');
  await js(`document.querySelector('#email').value = 'organizer@forgeboard.local'; document.querySelector('#password').value = 'forgeboard-demo'`);
  await click('form[action^="/login"] button[type=submit]');
  check('signing in with the form lands on the dashboard', (await js('location.pathname')) === '/dashboard');

  await go('/events/sample-hack-2026');
  check('UTC times carry a local-time tooltip', String(await js(`document.querySelector('time[datetime]')?.title`)).startsWith('Your time:'));

  await go('/organize/sample-hack-2026/results');
  await js(`document.querySelector('details.confirm summary').click()`);
  check('a two-step confirm opens to show the confirming button', await js(`document.querySelector('details.confirm').open`));

  await go('/organize/sample-hack-2026');
  await sleep(11_000);
  check('the organizer overview refreshes itself every 10 seconds', await js(`performance.getEntriesByType('resource').some((e) => e.name.endsWith('/organize/sample-hack-2026/progress'))`));
  check('the refreshed region still shows the dashboard', String(await js(`document.querySelector('[data-live]').textContent`)).includes('Submitted projects'));

  await viewport(390, true);
  await go('/projects');
  const navShown = () => js(`getComputedStyle(document.getElementById('site-nav')).display !== 'none'`);
  check('on a phone the menu starts closed', !(await navShown()));
  await js(`document.querySelector('.nav-toggle').click()`);
  check('the Menu button opens the navigation', (await navShown()) && (await js(`document.querySelector('.nav-toggle').getAttribute('aria-expanded')`)) === 'true');
  await key('Escape', 27);
  await sleep(100);
  check('Escape closes the menu and returns focus to the button', !(await navShown()) && (await js('document.activeElement.className')) === 'nav-toggle');

  await viewport(1280);
  await send('Network.clearBrowserCookies');
  await go('/signup');
  await js(`document.querySelector('#name').value = 'Browser Bea'; document.querySelector('#email').value = 'bea@example.com'; document.querySelector('#password').value = 'bea-password'`);
  await click('form[action^="/signup"] button[type=submit]');
  check('signing up with the form signs the person in', (await js(`document.querySelector('.nav-me')?.textContent`)) === 'Browser Bea');
  await go('/events/qa-open/team');
  await js(`document.querySelector('#name').value = 'Browser Team'`);
  await click('form[action="/events/qa-open/team"] button[type=submit]');
  check('creating a team shows the invite link', String(await js(`document.getElementById('invite-link')?.value`)).includes('/join/'));
  await js(`document.querySelector('[data-copy]').click()`);
  await sleep(200);
  check('the Copy button confirms with "Copied"', (await js(`document.querySelector('[data-copy]').textContent`)) === 'Copied');

  await go('/projects/new?event=qa-open');
  await js(`document.querySelector('#title').value = 'Browser Build'`);
  await click('button[value=draft]');
  check('Save draft creates a private draft', String(await js('document.body.innerText')).includes('Draft.'));
  const project = String(await js('location.pathname'));
  await go(`${project}/edit`);
  await js(`document.querySelector('#summary').value = 'Made in a browser'; document.querySelector('#track_id').selectedIndex = 1; document.querySelector('#repo_url').value = 'https://example.org/bea'`);
  await click('button[value=submit]');
  check('Submit project submits it', String(await js('document.body.innerText')).includes('Project submitted'));

  await send('Network.clearBrowserCookies');
  await send('Network.setCookie', { name: 'session', value: 'jdg_a_demo_91bc5e0f27d4a8c3', url: base });
  const own = (await (await fetch(`${base}/api/judge/scores`, { headers: { cookie: 'session=jdg_a_demo_91bc5e0f27d4a8c3' } })).json()) as { scores: { assignment_id: string }[] };
  await go(`/judge/reviews/${own.scores[0]?.assignment_id}`);
  await js(`document.querySelector('input[name=score_functionality][value="3"]').focus()`);
  await key('ArrowRight', 39);
  await sleep(100);
  check('arrow keys move between scores on the review form', (await js(`document.querySelector('input[name=score_functionality]:checked')?.value`)) === '4');
  await click('button[value=submit]');
  check('saving a review returns to the judging queue', String(await js('location.pathname')).startsWith('/judge/'));

  check('no JavaScript or console errors on any page', errors.length === 0);
} finally {
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (errors.length) console.log(`errors: ${errors.join(' | ')}`);
  console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} browser checks passed`);
  socket.close();
  chrome.kill();
  await new Promise((resolve) => chrome.on('exit', resolve));
  fs.rmSync(profile, { recursive: true, force: true });
  await server.close();
}
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
