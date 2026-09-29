// Width and zoom sweep: nothing may overflow the page horizontally, and no
// text may be clipped out of its box.
import { launch, ARTIFACTS } from "./cdp.mjs";
import { mintSessions } from "./sessions.mjs";
const BASE = process.argv[2] ?? "http://localhost:3000";
const cookies = mintSessions();
const PAGES = [
  ["anon", "/", "landing"],
  ["anon", "/events/autumn-build-2026/gallery", "gallery"],
  ["anon", "/events/autumn-build-2026", "event"],
  ["anon", "/events/autumn-build-2026/results", "results"],
  ["organizer", "/dashboard", "dashboard"],
  ["organizer", "/events/autumn-build-2026/organize", "organizer overview"],
  ["organizer", "/events/autumn-build-2026/organize/setup", "setup"],
  ["organizer", "/events/autumn-build-2026/organize/results", "scoring audit"],
  ["judge", "/events/autumn-build-2026/judge", "judge queue"],
  ["participant", "/events/autumn-build-2026/submit", "submission"],
];
// 200% zoom is emulated the way a browser does it: half the CSS viewport.
const SIZES = [[320, 900, "320"], [390, 900, "390"], [720, 900, "720 (=1440 at 200%)"], [1024, 900, "1024"], [1440, 900, "1440"]];

const b = await launch();
let problems = 0;
for (const [w, h, label] of SIZES) {
  await b.viewport(w, h);
  const bad = [];
  for (const [role, path, name] of PAGES) {
    await b.clearCookies();
    if (role !== "anon") await b.cookie("forgeboard_session", cookies[role], BASE);
    await b.goto(BASE + path, 700);
    const r = await b.eval(`(() => {
      const doc = document.documentElement;
      const overflow = doc.scrollWidth - doc.clientWidth;
      // Visible text wider than the box holding it, where nothing says it may
      // be cut: not screen-reader-only text, not a scroller, not an ellipsis,
      // not a box that deliberately hides its overflow (decoration), and not a
      // native file input, whose button makes the measurement meaningless.
      const clipped = [...document.querySelectorAll("main *")].filter((el) => {
        const s = getComputedStyle(el);
        if (s.position === "fixed" || s.position === "absolute") return false;
        if (["auto", "scroll", "hidden"].includes(s.overflowX)) return false;
        if (s.textOverflow === "ellipsis") return false;
        if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return false;
        if (el.closest(".sr-only") || el.classList.contains("sr-only")) return false;
        const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
        if (!ownText) return false;
        return el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0;
      }).slice(0, 4).map((el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ").slice(0, 2).join(".")
        + " «" + el.textContent.trim().slice(0, 30) + "»");
      return { overflow, clipped };
    })()`);
    if (r.overflow > 1 || r.clipped.length) {
      problems++;
      bad.push(`${name}: overflow ${r.overflow}px${r.clipped.length ? ", clipped " + r.clipped.join(", ") : ""}`);
    }
  }
  console.log(`${bad.length ? "!" : "·"} ${label.padEnd(22)} ${bad.length ? bad.join("; ") : "no horizontal overflow, nothing clipped"}`);
}
console.log(`\nlayout problems: ${problems}`);
await b.close();
