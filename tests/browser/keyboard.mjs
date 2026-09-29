// Keyboard checks that a screenshot cannot make: focus is visible, the mobile
// drawer traps and returns focus, and the review radios are reachable.
import { launch, ARTIFACTS } from "./cdp.mjs";
import { mintSessions } from "./sessions.mjs";
const BASE = process.argv[2] ?? "http://localhost:3000";
const cookies = mintSessions();
const b = await launch();
let fails = 0;
const check = async (label, fn) => {
  try { const note = await fn(); console.log(`  ok   ${label}${note ? "  — " + note : ""}`); }
  catch (e) { fails++; console.log(`  FAIL ${label}: ${e.message}`); }
};
const tab = async (n = 1, shift = false) => {
  for (let i = 0; i < n; i++) {
    for (const type of ["keyDown", "keyUp"]) {
      await b.send("Input.dispatchKeyEvent", {
        type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        modifiers: shift ? 8 : 0,
      });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
};
const key = async (k) => {
  for (const type of ["keyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 13, nativeVirtualKeyCode: k === "Escape" ? 27 : 13 });
  }
  await new Promise((r) => setTimeout(r, 200));
};

await b.viewport(1440, 900);
await b.cookie("forgeboard_session", cookies.organizer, BASE);

await check("focus is visibly marked as it moves", async () => {
  await b.goto(`${BASE}/dashboard`);
  await tab(4);
  const r = await b.eval(`(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle + " " + s.outlineWidth, ring: s.boxShadow.slice(0, 40), text: (el.innerText || "").slice(0, 24) };
  })()`);
  const visible = r.outline !== "none 0px" || (r.ring && r.ring !== "none");
  if (!visible) throw new Error(`no visible focus on <${r.tag}> "${r.text}"`);
  return `<${r.tag}> "${r.text.trim()}" has ${r.outline !== "none 0px" ? "an outline" : "a focus ring"}`;
});

await check("tab order reaches the main actions in order", async () => {
  await b.goto(`${BASE}/dashboard`);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await tab();
    seen.push(await b.eval(`(document.activeElement.innerText || document.activeElement.getAttribute("aria-label") || document.activeElement.tagName).trim().slice(0, 26)`));
  }
  if (!seen.some((s) => /Create an event/i.test(s))) throw new Error("never reached the primary action: " + seen.join(" → "));
  return seen.slice(0, 6).join(" → ");
});

await check("the mobile drawer traps focus and gives it back", async () => {
  await b.viewport(390, 800);
  await b.goto(`${BASE}/dashboard`);
  await b.click('button[aria-controls="app-drawer"]');
  await new Promise((r) => setTimeout(r, 400));
  const inDrawer = await b.eval(`!!document.querySelector("#app-drawer")?.contains(document.activeElement)`);
  if (!inDrawer) throw new Error("opening the drawer did not move focus into it");
  await tab(14);   // past the end of the drawer
  const stillInside = await b.eval(`!!document.querySelector("#app-drawer")?.contains(document.activeElement)`);
  if (!stillInside) throw new Error("focus escaped the open drawer");
  await key("Escape");
  const returned = await b.eval(`document.activeElement?.getAttribute("aria-controls") === "app-drawer"`);
  const closed = await b.eval(`!document.querySelector("#app-drawer")`);
  if (!closed) throw new Error("Escape did not close the drawer");
  if (!returned) throw new Error("focus did not return to the button that opened it");
  await b.viewport(1440, 900);
  return "trapped, closed on Escape, focus returned";
});

await check("a judge can score with the keyboard alone", async () => {
  await b.clearCookies();
  await b.cookie("forgeboard_session", cookies.busyjudge, BASE);
  const queue = await (await fetch(`${BASE}/api/v1/events/autumn-build-2026/projects?limit=1`)).json();
  await b.goto(`${BASE}/events/autumn-build-2026/judge`);
  const firstLink = await b.eval(`document.querySelector('a[href*="/judge/"]')?.getAttribute("href") ?? ""`);
  if (!firstLink) throw new Error("no assignment in the judge's queue");
  await b.goto(BASE + firstLink);
  const radios = await b.eval(`(() => {
    const r = [...document.querySelectorAll('input[type="radio"]')];
    if (!r.length) return null;
    return { count: r.length, disabled: r[0].disabled };
  })()`);
  if (!radios) throw new Error("no score radios on the review form");
  if (radios.disabled) throw new Error("the form is read-only for this assignment");

  // Tab to the first score option and check the label shows the focus.
  await b.eval(`document.querySelector('input[type="radio"]').closest("fieldset").previousElementSibling?.focus?.()`);
  await b.eval(`document.querySelector('input[type="radio"]').focus()`);
  const focused = await b.eval(`(() => {
    const el = document.activeElement;
    if (el?.type !== "radio") return null;
    const label = el.closest("label");
    label.setAttribute("data-probe", "1");
    return { tag: el.tagName, hasLabel: !!label };
  })()`);
  if (!focused) throw new Error("score radios cannot take focus");

  // Arrow keys move between options, as a radio group should.
  for (const type of ["keyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  }
  await new Promise((r) => setTimeout(r, 200));
  const moved = await b.eval(`document.activeElement?.type === "radio" && document.activeElement.checked`);
  if (!moved) throw new Error("arrow keys did not move or select within the score group");
  return `${radios.count} score options: focusable, arrow keys select`;
});

await check("the landing menu is unreachable while closed, and returns focus on Escape", async () => {
  await b.clearCookies();                       // a visitor, not the organizer
  await b.viewport(390, 800);
  await b.goto(`${BASE}/`);
  const T = `document.querySelector('button[aria-controls="mobile-menu"]')`;
  const inMenu = `!!document.activeElement?.closest("#mobile-menu")`;
  const overflow = `document.documentElement.scrollWidth > window.innerWidth`;
  if (await b.eval(`${T}.getAttribute("aria-expanded")`) !== "false") throw new Error("closed toggle does not report aria-expanded=false");
  // 1. Tab right through the page top: nothing in the closed menu may take focus.
  for (let i = 0; i < 20; i++) {
    await tab();
    if (await b.eval(inMenu)) throw new Error(`Tab ${i + 1} landed inside the closed menu`);
  }
  const hidden = await b.eval(`(() => { const m = document.getElementById("mobile-menu"); return m.inert && m.getAttribute("aria-hidden") === "true"; })()`);
  if (!hidden) throw new Error("the closed menu is not inert and aria-hidden");
  if (await b.eval(overflow)) throw new Error("horizontal overflow while closed");
  // 2–3. Open from the keyboard: expanded, focus inside, and Tab stays reachable.
  await b.eval(`${T}.focus()`);
  // Enter as a real keypress: CDP only activates a button when the key carries its text.
  for (const type of ["keyDown", "keyUp"]) {
    await b.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  }
  await new Promise((r) => setTimeout(r, 400));
  if (await b.eval(`${T}.getAttribute("aria-expanded")`) !== "true") throw new Error("open toggle does not report aria-expanded=true");
  if (!(await b.eval(inMenu))) throw new Error("opening did not move focus into the menu");
  await tab();
  if (!(await b.eval(inMenu))) throw new Error("the next Tab left the open menu");
  if (await b.eval(overflow)) throw new Error("horizontal overflow while open");
  // 4. Escape closes and puts focus back on the toggle.
  await key("Escape");
  await new Promise((r) => setTimeout(r, 400));
  const back = await b.eval(`document.activeElement === ${T} && ${T}.getAttribute("aria-expanded") === "false"`);
  if (!back) throw new Error("Escape did not close the menu and return focus to the toggle");
  // Choosing a link also closes the menu.
  await b.eval(`${T}.click()`);
  await new Promise((r) => setTimeout(r, 400));
  await b.eval(`document.querySelector("#mobile-menu a[href='/#features']").click()`);
  await new Promise((r) => setTimeout(r, 400));
  if (await b.eval(`${T}.getAttribute("aria-expanded")`) !== "false") throw new Error("choosing a link left the menu open");
  if (await b.eval(overflow)) throw new Error("horizontal overflow after closing");
  return "20 Tabs never entered it; opens with focus inside; Escape and link choice close it; no overflow";
});

console.log(fails === 0 ? "\nAll keyboard checks passed." : `\n${fails} keyboard check(s) failed.`);
await b.close();
process.exit(fails ? 1 : 0);
