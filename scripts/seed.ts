/**
 * Idempotent demo seed.
 *
 * Running it twice is a no-op. The dataset is deliberately awkward: it contains
 * a reviewer who scores everything the same, a judge who left half a batch
 * unfinished, a project nobody has reviewed yet, a withdrawn entry and two
 * drafts that never got submitted. A portal that only works on tidy input
 * should fail here rather than on the day.
 */
import { migrate, db, run, get, all, nowIso, DB_PATH } from "../lib/db/client.ts";
import { newId, slugify } from "../lib/ids.ts";
import { hashPassword } from "../lib/auth/password.ts";

const EVENT_SLUG = "autumn-build-2026";
const DEMO_PASSWORD = "forgeboard2026";

migrate();

if (get(`SELECT id FROM events WHERE slug = ?`, EVENT_SLUG)) {
  console.log(`[forgeboard] seed already present (${EVENT_SLUG}); nothing to do.`);
  process.exit(0);
}

// One hash, reused across demo accounts: seeding 130 scrypt hashes would add
// ten seconds to `docker compose up` for no benefit. Real registrations always
// hash individually.
const { hash, salt } = hashPassword(DEMO_PASSWORD);

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260925);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const now = nowIso();
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 864e5).toISOString();

function mkUser(email: string, displayName: string, role: "admin" | "user" = "user"): string {
  // The fixture import may already have made this account (admin, organizer): reuse it.
  const existing = get<{ id: string }>(`SELECT id FROM users WHERE email_ci = ?`, email.toLowerCase());
  if (existing) {
    if (role === "admin") run(`UPDATE users SET global_role = 'admin' WHERE id = ?`, existing.id);
    return existing.id;
  }
  const id = newId("usr");
  run(
    `INSERT INTO users (id, email, email_ci, password_hash, password_salt, display_name, global_role, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, email, email.toLowerCase(), hash, salt, displayName, role, now, now,
  );
  return id;
}

const FIRST = ["Ada","Bo","Cleo","Dev","Esme","Finn","Gita","Hugo","Iris","Jonah","Kaya","Lior","Mina","Nils","Oona","Paulo","Quinn","Rhea","Sol","Tova","Umi","Vero","Wren","Xan","Yuki","Zane","Anya","Bram","Cora","Dara","Elio","Fern","Gus","Hana","Ines","Jai","Kit","Lena","Mo","Nia"];
const LAST = ["Okafor","Lindqvist","Batista","Novak","Haddad","Moreau","Rani","Petrov","Silva","Chen","Adeyemi","Kovacs","Dubois","Ferrara","Nakamura","Oyelaran","Vargas","Weiss","Zhu","Costa"];
const usedNames = new Set<string>();
function personName(): string {
  for (let i = 0; i < 200; i++) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  return `Participant ${usedNames.size + 1}`;
}

console.log("[forgeboard] seeding demo event…");

// ---------------------------------------------------------------- accounts --
const adminId = mkUser("admin@forgeboard.local", "Instance Admin", "admin");
const organizerId = mkUser("organizer@forgeboard.local", "Robin Vance");
const judgeDemoId = mkUser("judge@forgeboard.local", "Sam Ortiz");
const participantDemoId = mkUser("participant@forgeboard.local", "Alex Mercer");

// ------------------------------------------------------------------- event --
const eventId = newId("evt");
run(
  `INSERT INTO events (id, slug, name, tagline, description, timezone, status,
     submissions_open_at, submissions_close_at, judging_open_at, judging_close_at,
     reviews_per_project, max_team_size, created_by, created_at, updated_at)
   VALUES (?,?,?,?,?,?, 'judging', ?,?,?,?, 3, 4, ?,?,?)`,
  eventId, EVENT_SLUG, "Autumn Build 2026",
  "Seventy-two hours, one product, judged in the open.",
  "A demonstration event seeded with synthetic data so you can see Forgeboard mid-flight: submissions closed, judging under way, results not yet published.\n\nEvery person, team and project below is fictional.",
  "UTC", iso(-14), iso(-3), iso(-3), iso(7), organizerId, now, now,
);
run(`INSERT INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'organizer', ?,?)`,
  newId("rol"), eventId, organizerId, organizerId, now);
// The admin account deliberately holds no role in this event. It can still
// reach the console — that is what instance administration is — and the
// event's audit trail records each time it does.

const TRACK_DEFS = [
  ["Developer tooling", "Things that make building software less miserable."],
  ["Data and analytics", "Pipelines, warehouses, notebooks and the charts on top."],
  ["Health and accessibility", "Software that widens who gets to participate."],
  ["Climate and energy", "Measurement, efficiency and grid-adjacent work."],
  ["Civic technology", "Public services, transparency and local government."],
  ["Education", "Teaching, assessment and learning at any age."],
  ["Security and privacy", "Defence, auditing and data minimisation."],
  ["Open infrastructure", "The unglamorous layers everything else sits on."],
];
const trackIds = TRACK_DEFS.map(([name, description], i) => {
  const id = newId("trk");
  run(`INSERT INTO tracks (id, event_id, name, slug, description, sort_order) VALUES (?,?,?,?,?,?)`,
    id, eventId, name, slugify(name), description, i);
  return id;
});

for (const [name, amount, desc] of [
  ["Grand prize", "$800", "Best overall entry across every track."],
  ["Runner-up", "$500", "Second place overall."],
  ["Third place", "$350", "Third place overall."],
  ["Best judging engine", "$100", "Most defensible scoring and assignment work."],
] as const) {
  run(`INSERT INTO prizes (id, event_id, name, amount_text, description, sort_order) VALUES (?,?,?,?,?,?)`,
    newId("prz"), eventId, name, amount, desc, 0);
}

// The demo event asks one of each kind of question, and marks the first one
// public so the gallery has something to show while the rest stay private.
const questionIds = ([
  ["What problem does this solve, in one paragraph?", "long_text", 1, 1, []],
  ["What did you cut, and why?", "long_text", 0, 0, []],
  ["Link to a 60-second walkthrough (optional)", "url", 0, 0, []],
  ["How far along is it?", "single_select", 0, 1, ["Prototype", "Working demo", "In production"]],
  ["What would you need to keep going?", "multi_select", 0, 0, ["Time", "Users to test with", "A co-maintainer", "Nothing, it is done"]],
] as const).map(([prompt, kind, required, isPublic, options], i) => {
  const id = newId("qst");
  run(
    `INSERT INTO custom_questions (id, event_id, prompt, kind, required, is_public, options_json, sort_order)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, eventId, prompt, kind, required, isPublic, JSON.stringify(options), i,
  );
  return id;
});

// ------------------------------------------------------------------ rubric --
const rubricId = newId("rub");
run(`INSERT INTO rubric_versions (id, event_id, version, name, status, created_by, created_at, published_at)
     VALUES (?,?, 1, 'Autumn Build rubric', 'published', ?,?,?)`, rubricId, eventId, organizerId, now, now);
const criterionIds = ([
  ["Completeness", "How much of the brief is actually finished and working.", 40],
  ["Integrity", "Are the rules enforced where they cannot be bypassed?", 25],
  ["Operability", "Could a stranger run this on Monday without asking a question?", 20],
  ["Craft", "Schema, code and interface quality.", 15],
] as const).map(([name, description, weight], i) => {
  const id = newId("crt");
  run(`INSERT INTO criteria (id, rubric_version_id, name, description, weight, scale_min, scale_max, sort_order)
       VALUES (?,?,?,?,?,1,5,?)`, id, rubricId, name, description, weight, i);
  return id;
});

// ------------------------------------------------------------------ judges --
type Judge = { id: string; name: string; style: "fair" | "harsh" | "generous" | "flat" | "absent" | "partial" };
const judges: Judge[] = [];
judges.push({ id: judgeDemoId, name: "Sam Ortiz", style: "fair" });
const STYLES: Judge["style"][] = ["fair","fair","fair","fair","harsh","generous","fair","fair","flat","fair","partial","fair","generous","harsh","fair","absent","fair","fair","generous","fair"];
for (let i = 0; i < STYLES.length; i++) {
  const name = personName();
  judges.push({ id: mkUser(`judge${i + 1}@forgeboard.local`, name), name, style: STYLES[i] });
}
// Two judges are confined to a single track, to exercise track isolation.
judges.forEach((j, i) => {
  const restricted = i === 3 ? trackIds[0] : i === 7 ? trackIds[2] : null;
  run(`INSERT INTO event_roles (id, event_id, user_id, role, track_id, granted_by, created_at) VALUES (?,?,?, 'judge', ?,?,?)`,
    newId("rol"), eventId, j.id, restricted, organizerId, now);
});

// ------------------------------------------------- teams, members, projects --
const PROJECT_NAMES = [
  "Lantern","Sieve","Quarry","Tidemark","Pinboard","Ledgerly","Thicket","Beacon","Cobble","Drydock",
  "Fathom","Gantry","Harbour","Inkwell","Junction","Keelson","Lattice","Millrace","Notary","Orchard",
  "Paddock","Quayside","Rookery","Signal","Trellis","Undertow","Vantage","Windlass","Yardarm","Zephyr",
  "Anvil","Bellows","Crucible","Dovetail","Escapement","Flywheel","Gudgeon","Hobnail","Ironwood","Joist",
];
const TAGS = ["typescript","python","rust","go","postgres","sqlite","react","svelte","offline-first","cli","api","docker","wasm","elixir","htmx","accessibility","charts","realtime"];

type Proj = { id: string; trackId: string | null; teamId: string; name: string; status: string };
const projects: Proj[] = [];

for (let i = 0; i < PROJECT_NAMES.length; i++) {
  const projectName = PROJECT_NAMES[i];
  const teamId = newId("tem");
  const teamName = `Team ${projectName}`;
  run(`INSERT INTO teams (id, event_id, name, created_by, created_at) VALUES (?,?,?,?,?)`,
    teamId, eventId, teamName, organizerId, now);

  const size = 1 + Math.floor(rand() * 4);
  for (let m = 0; m < size; m++) {
    // The demo participant owns the first team so signing in lands somewhere useful.
    const userId = (i === 0 && m === 0)
      ? participantDemoId
      : mkUser(`member${i + 1}-${m + 1}@forgeboard.local`, personName());
    run(`INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?,?,?)`,
      newId("tmm"), teamId, userId, m === 0 ? "owner" : "member", now);
    run(`INSERT INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'participant', ?,?)`,
      newId("rol"), eventId, userId, organizerId, now);
  }

  // 36 submitted, 2 drafts, 1 withdrawn, 1 submitted but never reviewed.
  const status = i === 36 || i === 37 ? "draft" : i === 38 ? "withdrawn" : "submitted";
  const trackId = trackIds[i % trackIds.length];
  const projectId = newId("prj");
  run(
    `INSERT INTO projects (id, event_id, team_id, track_id, name, tagline, description,
       demo_video_url, repo_url, live_url, status, submitted_at, withdrawn_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    projectId, eventId, teamId, trackId, projectName,
    `${pick(["A quieter","A faster","A smaller","An honest","A self-hosted","A portable"])} way to ${pick(["ship","measure","review","archive","schedule","reconcile"])} ${pick(["submissions","datasets","deployments","reports","volunteers","invoices"])}.`,
    `${projectName} started as a weekend irritation and turned into something we actually use.\n\nIt keeps its data in one place, runs from a single command, and does not phone home. The interesting part is the ${pick(["scheduler","indexer","reconciler","diff engine","queue"])}: it is deliberately boring so that the failure modes are ones we can reason about at 3am.\n\nWhat is not finished: the import path is thin, and we know it.`,
    i % 4 === 0 ? `https://example.org/demo/${slugify(projectName)}` : "",
    `https://example.org/git/${slugify(projectName)}`,
    i % 3 === 0 ? `https://example.org/live/${slugify(projectName)}` : "",
    status,
    status === "submitted" ? iso(-4 + rand()) : null,
    status === "withdrawn" ? iso(-2) : null,
    now, now,
  );
  const tagCount = 2 + Math.floor(rand() * 3);
  const chosen = new Set<string>();
  while (chosen.size < tagCount) chosen.add(pick(TAGS));
  for (const tag of chosen) run(`INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?,?)`, projectId, tag);

  run(`INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at) VALUES (?,?,?,?,?)`,
    newId("ans"), projectId, questionIds[0],
    `Organisers keep doing this by hand in spreadsheets. ${projectName} moves it into something with constraints.`, now);
  if (i % 3 === 0) {
    run(`INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at) VALUES (?,?,?,?,?)`,
      newId("ans"), projectId, questionIds[1], "We cut the notification system. Nobody asked for it and it would have needed a mail server.", now);
  }
  run(`INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at) VALUES (?,?,?,?,?)`,
    newId("ans"), projectId, questionIds[3], ["Prototype", "Working demo", "In production"][i % 3], now);
  if (i % 2 === 0) {
    // Several choices are stored one per line.
    run(`INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at) VALUES (?,?,?,?,?)`,
      newId("ans"), projectId, questionIds[4], "Time\nUsers to test with", now);
  }
  if (status !== "draft") {
    run(`INSERT INTO submission_revisions (id, project_id, revision, snapshot_json, reason, created_by, created_at)
         VALUES (?,?,1,?,'submit',?,?)`,
      newId("rev"), projectId, JSON.stringify({ name: projectName, status }), organizerId, now);
  }
  projects.push({ id: projectId, trackId, teamId, name: projectName, status });
}

// ------------------------------------------------------------- assignments --
const submitted = projects.filter((p) => p.status === "submitted");
const loads = new Map(judges.map((j) => [j.id, 0]));
const teamMemberIds = new Map<string, Set<string>>();
for (const p of projects) {
  teamMemberIds.set(p.id, new Set(all<{ user_id: string }>(
    `SELECT user_id FROM team_members WHERE team_id = ?`, p.teamId).map((r) => r.user_id)));
}
const judgeTrack = new Map<string, string | null>();
for (const j of judges) {
  const row = get<{ track_id: string | null }>(
    `SELECT track_id FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'judge'`, eventId, j.id);
  judgeTrack.set(j.id, row?.track_id ?? null);
}

// The last submitted project is left unassigned on purpose: an organizer must
// be able to see a coverage hole, not just a tidy dashboard.
const assignable = submitted.slice(0, -1);
const assignments: { id: string; judge: Judge; project: Proj }[] = [];

for (const project of assignable) {
  const eligible = judges
    .filter((j) => {
      const t = judgeTrack.get(j.id);
      if (t !== null && t !== project.trackId) return false;
      return !teamMemberIds.get(project.id)!.has(j.id);
    })
    .sort((a, b) => (loads.get(a.id)! - loads.get(b.id)!) || a.name.localeCompare(b.name));
  for (const judge of eligible.slice(0, 3)) {
    const id = newId("asg");
    run(`INSERT INTO assignments (id, event_id, project_id, judge_user_id, status, batch_label, assigned_by, assigned_at)
         VALUES (?,?,?,?, 'pending', 'batch-01', ?, ?)`,
      id, eventId, project.id, judge.id, organizerId, now);
    loads.set(judge.id, loads.get(judge.id)! + 1);
    assignments.push({ id, judge, project });
  }
}

// ----------------------------------------------------------------- reviews --
// Each project carries a latent quality; judges perceive it through their own
// bias. That is what makes normalization worth doing on this dataset.
const quality = new Map(submitted.map((p, i) => [p.id, 1.5 + ((i * 37) % 100) / 100 * 3.2]));

function scoreFor(style: Judge["style"], q: number, jitter: number): number {
  let base = q;
  if (style === "harsh") base -= 1.1;
  if (style === "generous") base += 1.0;
  if (style === "flat") return 3;
  base += (jitter - 0.5) * 0.7;
  return Math.max(1, Math.min(5, Math.round(base)));
}

let submittedReviews = 0, draftReviews = 0;
assignments.forEach((a, idx) => {
  if (a.judge.style === "absent") return;                    // never started
  const partialSkip = a.judge.style === "partial" && idx % 2 === 0;
  const q = quality.get(a.project.id)!;
  const reviewId = newId("rvw");
  const isDraft = partialSkip;

  const scores = criterionIds.map((cid) => ({ cid, s: scoreFor(a.judge.style, q, rand()) }));
  const weights = [40, 25, 20, 15];
  const weighted = scores.reduce((acc, s, i) => acc + s.s * weights[i], 0) / 100;
  // Same review mapped to 0-100 using the 1-5 endpoints, as the app does.
  const weighted100 = (100 * scores.reduce((acc, s, i) => acc + weights[i] * ((s.s - 1) / 4), 0)) / 100;

  run(
    `INSERT INTO reviews (id, assignment_id, rubric_version_id, status, overall_comment,
       raw_weighted, raw_weighted_100, complete, created_at, updated_at, submitted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    reviewId, a.id, rubricId, isDraft ? "draft" : "submitted",
    isDraft ? "" : pick([
      "Clear scope and it does what the README says. The export path is the weakest part.",
      "Genuinely useful. I would run this. Schema is sensible and the migrations are readable.",
      "Ambitious, and about eighty percent finished. The judging view needs another pass.",
      "Solid engineering, quiet interface. I wanted more from the empty states.",
      "Does one thing properly rather than five things approximately. That counts for a lot.",
    ]),
    isDraft ? null : weighted, isDraft ? null : weighted100, isDraft ? 0 : 1,
    now, now, isDraft ? null : now,
  );
  for (const s of scores) {
    run(`INSERT INTO criterion_scores (id, review_id, criterion_id, score, comment) VALUES (?,?,?,?,?)`,
      newId("csc"), reviewId, s.cid, s.s, "");
  }
  run(`UPDATE assignments SET status = ? WHERE id = ?`, isDraft ? "in_progress" : "submitted", a.id);
  isDraft ? draftReviews++ : submittedReviews++;
});

run(`INSERT INTO audit_events (id, event_id, actor_user_id, actor_label, action, subject_type, subject_id, detail_json, outcome, created_at)
     VALUES (?,?,?,?, 'seed.load', 'event', ?, ?, 'ok', ?)`,
  newId("aud"), eventId, organizerId, "Seed script", eventId,
  JSON.stringify({ projects: projects.length, judges: judges.length, reviews: submittedReviews }), now);

const userCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)!.n;
console.log(`[forgeboard] seeded ${DB_PATH}`);
console.log(`  event            ${EVENT_SLUG} (judging in progress)`);
console.log(`  users            ${userCount}  (${judges.length} judges)`);
console.log(`  projects         ${projects.length} (${submitted.length} submitted, 1 left unassigned on purpose)`);
console.log(`  reviews          ${submittedReviews} submitted, ${draftReviews} still in draft`);
console.log(`  demo password    ${DEMO_PASSWORD}`);
console.log(`  sign in as       admin@forgeboard.local | organizer@forgeboard.local | judge@forgeboard.local | participant@forgeboard.local`);
