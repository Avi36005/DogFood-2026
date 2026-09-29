/**
 * A very small headless-Chrome driver over the DevTools Protocol, using Node's
 * built-in WebSocket. No Playwright, no Puppeteer, nothing to install: the
 * browser checks in this directory need a Chrome on the machine and nothing
 * else, so they can be run from a clean clone.
 *
 * Set CHROME to point at a different binary.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export const ARTIFACTS = path.join(process.cwd(), "tests", "browser", ".artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333 + Math.floor(Math.random() * 500) } = {}) {
  const chrome = CANDIDATES.find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  }) ?? CANDIDATES[0];

  const profile = mkdtempSync(path.join(tmpdir(), "forgeboard-chrome-"));
  const proc = spawn(chrome, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank",
  ], { stdio: "ignore" });

  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; }
    catch { await sleep(100); }
  }
  if (!targets) throw new Error(`could not start Chrome (${chrome}); set CHROME to the binary`);
  const pageTarget = targets.find((t) => t.type === "page");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
  });

  const errors = [];
  listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
      errors.push(`log(${m.params.entry.source}): ${m.params.entry.text} ${m.params.entry.url ?? ""}`.slice(0, 300));
  });
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");

  // Native dialogs (the unsaved-changes prompt) would otherwise wedge the tab.
  const dialogs = [];
  let dialogAnswer = true;
  listeners.push((m) => {
    if (m.method !== "Page.javascriptDialogOpening") return;
    dialogs.push({ type: m.params.type, message: m.params.message });
    send("Page.handleJavaScriptDialog", { accept: dialogAnswer }).catch(() => {});
  });

  const b = {
    send, errors, listeners, dialogs,
    answerDialogs(accept) { dialogAnswer = accept; },
    async viewport(width, height = 900, scale = 1) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: width < 600 });
    },
    async cookie(name, value, url) { await send("Network.setCookie", { name, value, url, path: "/" }); },
    async clearCookies() { await send("Network.clearBrowserCookies"); },
    async goto(url, settle = 900) {
      const loaded = new Promise((r) => {
        const l = (m) => { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(); } };
        listeners.push(l);
      });
      await send("Page.navigate", { url });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(settle);
    },
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    },
    url() { return b.eval("location.href"); },
    async waitFor(expression, timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (await b.eval(`!!(${expression})`)) return true; await sleep(120); }
      throw new Error("timed out waiting for: " + expression);
    },
    /** Real keyboard input: focus the field, select its contents, insert text. */
    async type(selector, text) {
      await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element ${selector.replace(/"/g, "'")}"); el.focus(); el.select?.(); })()`);
      await send("Input.insertText", { text });
    },
    /** Real mouse click at the element's centre, after scrolling it into view. */
    async click(selector) {
      const box = await b.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.scrollIntoView({ block: "center", behavior: "instant" }); const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error("no element to click: " + selector);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    async clickText(tag, text) {
      const sel = await b.eval(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(tag)})].filter(e => e.textContent.trim() === ${JSON.stringify(text)} || e.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!els.length) return null; els[0].setAttribute("data-probe-click", "1"); return "[data-probe-click]"; })()`);
      if (!sel) throw new Error(`no ${tag} with text ${text}`);
      await b.click(sel);
      await b.eval(`document.querySelector("[data-probe-click]")?.removeAttribute("data-probe-click")`);
    },
    async key(name, code) {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      }
      await sleep(120);
    },
    async tab(n = 1, shift = false) {
      for (let i = 0; i < n; i++) {
        for (const type of ["keyDown", "keyUp"]) {
          await send("Input.dispatchKeyEvent", {
            type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
            modifiers: shift ? 8 : 0,
          });
        }
        await sleep(60);
      }
    },
    async screenshot(file, { full = false } = {}) {
      let clip;
      if (full) {
        const { cssContentSize } = await send("Page.getLayoutMetrics");
        clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16000), scale: 1 };
      }
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, ...(clip ? { clip } : {}) });
      const out = path.isAbsolute(file) ? file : path.join(ARTIFACTS, file);
      writeFileSync(out, Buffer.from(data, "base64"));
      return out;
    },
    /** Runs axe-core in the page. axe-core is a devDependency of this project. */
    async axe() {
      const src = readFileSync(path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");
      await b.eval(src + ";true");
      return b.eval(`axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] })
        .then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length,
          targets: v.nodes.slice(0, 4).map(n => n.target.join(" ")) })))`);
    },
    async close() {
      try { ws.close(); } catch {}
      proc.kill("SIGKILL");
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
  return b;
}
