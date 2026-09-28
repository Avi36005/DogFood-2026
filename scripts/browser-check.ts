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

