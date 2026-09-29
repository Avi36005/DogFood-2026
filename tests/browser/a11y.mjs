// axe-core over the screens that matter, in the roles that reach them.
import { launch, ARTIFACTS } from "./cdp.mjs";
import { mintSessions } from "./sessions.mjs";
const BASE = process.argv[2] ?? "http://localhost:3000";
const cookies = mintSessions();
const PAGES = [
  ["anon", "/", "landing"],
  ["anon", "/signin", "sign in"],
  ["anon", "/register", "register"],
  ["anon", "/events/autumn-build-2026", "event page"],
  ["anon", "/events/autumn-build-2026/gallery", "gallery"],
  ["anon", "/events/autumn-build-2026/results", "published results"],
  ["organizer", "/dashboard", "dashboard"],
  ["organizer", "/events/autumn-build-2026/organize", "organizer overview"],
  ["organizer", "/events/autumn-build-2026/organize/setup", "event setup"],
  ["organizer", "/events/autumn-build-2026/organize/panel", "judging panel"],
  ["organizer", "/events/autumn-build-2026/organize/projects", "projects"],
  ["organizer", "/events/autumn-build-2026/organize/results", "scoring audit"],
  ["judge", "/events/autumn-build-2026/judge", "judge queue"],
  ["participant", "/events/autumn-build-2026/submit", "submission form"],
  ["participant", "/events/autumn-build-2026/team", "team"],
];
const b = await launch();
await b.viewport(1440, 1000);
let total = 0;
for (const [role, path, label] of PAGES) {
  await b.clearCookies();
  if (role !== "anon") await b.cookie("forgeboard_session", cookies[role], BASE);
  await b.goto(BASE + path, 1000);
  const violations = await b.axe();
  const serious = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  total += serious.length;
  console.log(`${serious.length ? "!" : "·"} ${label.padEnd(20)} ${violations.length} violation(s)` +
    (violations.length ? "" : "  none"));
  for (const v of violations) {
    console.log(`    [${v.impact}] ${v.id}: ${v.help} (${v.n} node(s))`);
    console.log(`      ${v.targets.slice(0, 3).join(" | ")}`);
  }
}
console.log(`\nserious or critical violations across ${PAGES.length} screens: ${total}`);
await b.close();
