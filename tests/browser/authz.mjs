/**
 * The authorization matrix, over real HTTP: every route below requested as each
 * role with a real session cookie, then the CSRF and API-key cases.
 *
 *   node tests/browser/authz.mjs [base-url] [event-slug]
 */
import { mintSessions, runAgainstDb } from "./sessions.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SLUG = process.argv[3] ?? "autumn-build-2026";
const tokens = mintSessions();

// Fixture ids straight from the database the application is serving.
const run = runAgainstDb;
const q = (sql) => JSON.parse(run(
  `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.FORGEBOARD_DB_PATH);
   console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`).trim().split("\n").pop());
const [judge] = q(`SELECT id FROM users WHERE email = 'judge@forgeboard.local'`);
// Both assignments come from the event under test, so a refusal is about the judge, not the event.
const inEvent = `a.event_id = (SELECT id FROM events WHERE slug = '${SLUG}')`;
const own = q(`SELECT a.id FROM assignments a WHERE a.judge_user_id = '${judge.id}' AND ${inEvent} LIMIT 1`)[0];
const other = q(`SELECT a.id FROM assignments a WHERE a.judge_user_id <> '${judge.id}' AND ${inEvent} LIMIT 1`)[0];

// An organizer API key, issued exactly as lib/api/keys.ts issue() does.
const key = run(`
  import { DatabaseSync } from "node:sqlite"; import { randomBytes, createHash } from "node:crypto";
  const db = new DatabaseSync(process.env.FORGEBOARD_DB_PATH);
  const u = db.prepare("SELECT id FROM users WHERE email = 'organizer@forgeboard.local'").get();
  const e = db.prepare("SELECT id FROM events WHERE slug = '${SLUG}'").get();
  const t = "fbk_" + randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO api_keys (id, event_id, user_id, label, token_hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)")
    .run("key_audit" + randomBytes(6).toString("hex"), e.id, u.id, "audit probe", createHash("sha256").update(t).digest("hex"), "read,write", new Date().toISOString());
  console.log(t);`).trim().split("\n").pop();

async function hit(path, role, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (role && role !== "anon") headers.cookie = `forgeboard_session=${tokens[role]}`;
  const r = await fetch(BASE + path, { redirect: "manual", ...init, headers });
  // Drain the body before moving on. A streamed response resolves `fetch` when
  // the headers arrive, so without this the next step can read the audit trail
  // while the server is still rendering — and miss the refusal it just caused.
  await r.arrayBuffer();
  const loc = r.headers.get("location");
  return r.status + (loc ? ` → ${loc.replace(BASE, "").split("?")[0]}` : "");
}

const roles = ["anon", "participant", "judge", "organizer", "admin"];
const rows = [
  `/dashboard`, `/admin`,
  `/events/${SLUG}/organize`, `/events/${SLUG}/organize/setup`, `/events/${SLUG}/organize/results`,
  `/events/${SLUG}/organize/audit`, `/events/${SLUG}/organize/integrations`, `/events/${SLUG}/organize/projects`,
  `/events/${SLUG}/judge`, `/events/${SLUG}/judge/${own.id}`, `/events/${SLUG}/judge/${other.id}`,
  `/events/${SLUG}/team`, `/events/${SLUG}/submit`,
  `/api/events/${SLUG}/export/reviews`, `/api/events/${SLUG}/export/audit`,
  `/api/v1/events/${SLUG}/reviews`, `/api/v1/events/${SLUG}/judges`, `/api/v1/events/${SLUG}/export`,
  `/api/v1/events/${SLUG}/results`, `/api/v1/events/${SLUG}/progress`,
];
// The policy each cell must match. `S` = signin redirect, `D` = dashboard redirect,
// `T` = team redirect (signed in, but no team yet). Anything else is a literal status.
const S = "307 → /signin", D = "307 → /dashboard", T = `307 → /events/${SLUG}/team`;
const expected = {
  [`/dashboard`]:                               [S, "200", "200", "200", "200"],
  [`/admin`]:                                   [S, D, D, D, "200"],
  [`/events/${SLUG}/organize`]:                 [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/organize/setup`]:           [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/organize/results`]:         [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/organize/audit`]:           [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/organize/integrations`]:    [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/organize/projects`]:        [S, "404", "404", "200", "200"],
  [`/events/${SLUG}/judge`]:                    [S, "404", "200", "404", "404"],
  [`/events/${SLUG}/judge/${own.id}`]:          [S, "404", "200", "404", "404"],
  [`/events/${SLUG}/judge/${other.id}`]:        [S, "404", "404", "404", "404"],
  [`/events/${SLUG}/team`]:                     [S, "200", "200", "200", "200"],
  [`/events/${SLUG}/submit`]:                   [S, "200", T, T, T],
  [`/api/events/${SLUG}/export/reviews`]:       ["403", "403", "403", "200", "200"],
  [`/api/events/${SLUG}/export/audit`]:         ["403", "403", "403", "200", "200"],
  [`/api/v1/events/${SLUG}/reviews`]:           ["403", "403", "403", "200", "200"],
  [`/api/v1/events/${SLUG}/judges`]:            ["403", "403", "403", "200", "200"],
  [`/api/v1/events/${SLUG}/export`]:            ["403", "403", "403", "200", "200"],
  // Nothing is published in the seed, so results are absent for everyone.
  [`/api/v1/events/${SLUG}/results`]:           ["404", "404", "404", "404", "404"],
  [`/api/v1/events/${SLUG}/progress`]:          ["403", "403", "403", "200", "200"],
};
const failures = [];
const out = ["| path | " + roles.join(" | ") + " |", "|---|" + roles.map(() => "---").join("|") + "|"];
for (const p of rows) {
  const cells = [];
  const label = p.replace(SLUG, ":slug").replace(own.id, ":own-assignment").replace(other.id, ":other-judge's-assignment");
  for (const [i, r] of roles.entries()) {
    const got = await hit(p, r);
    const want = expected[p][i];
    if (got !== want) failures.push(`${label} as ${r}: got ${got}, expected ${want}`);
    cells.push(got === want ? got : `**${got}** (want ${want})`);
  }
  out.push(`| \`${label}\` | ${cells.join(" | ")} |`);
}
console.log(out.join("\n"));

// Was the judge's attempt on someone else's assignment audited?
const refusals = q(`SELECT e.actor_label, e.action, e.subject_id, e.detail_json FROM audit_events e WHERE e.outcome = 'denied' ORDER BY e.created_at DESC LIMIT 5`);
console.log("\nrefusals written to the audit trail by this run:");
for (const r of refusals) console.log("  ", r.actor_label, r.action, r.subject_id === other.id ? ":other-judge's-assignment" : r.subject_id, r.detail_json);
if (!refusals.some((r) => r.subject_id === other.id && r.action === "review.open")) {
  failures.push("the judge's attempt on another judge's assignment was not audited");
}

// CSRF: cookie-authenticated POSTs must be same-origin; API keys are unaffected.
// The body is deliberately invalid, so a request that passes the guard stops at 422 and changes nothing.
const bad = JSON.stringify({ name: "x" });
const ct = { "content-type": "application/json" };
const self = new URL(BASE).origin;
const post = (role, headers) => hit("/api/v1/events", role, { method: "POST", body: bad, headers: { ...ct, ...headers } });
const csrf = [
  ["organizer cookie, Origin http://localhost:8080", () => post("organizer", { origin: "http://localhost:8080" }), "403"],
  ["organizer cookie, Origin http://evil.example",   () => post("organizer", { origin: "http://evil.example" }), "403"],
  ["organizer cookie, no Origin header",             () => post("organizer", {}), "403"],
  [`organizer cookie, same Origin ${self}`,          () => post("organizer", { origin: self }), "422"],
  ["organizer API key, no Origin",                   () => post(null, { authorization: `Bearer ${key}` }), "422"],
  ["anonymous",                                      () => post("anon", {}), "401"],
  ["API key GET reviews (organizer's key)",          () => hit(`/api/v1/events/${SLUG}/reviews`, null, { headers: { authorization: `Bearer ${key}` } }), "200"],
  ["bogus API key GET reviews",                      () => hit(`/api/v1/events/${SLUG}/reviews`, null, { headers: { authorization: "Bearer fbk_nope" } }), "403"],
];
console.log("\nCSRF on POST /api/v1/events (invalid body, so nothing is written):");
for (const [label, fn, want] of csrf) {
  const got = await fn();
  if (got !== want) failures.push(`CSRF ${label}: got ${got}, expected ${want}`);
  console.log(`  ${label.padEnd(48)}: ${got}${got === want ? "" : `  ✖ expected ${want}`}`);
}

const cases = rows.length * roles.length + 1 + csrf.length;
console.log(`\n${cases - failures.length}/${cases} checks match the policy`);
if (failures.length) {
  console.error("\nFAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
