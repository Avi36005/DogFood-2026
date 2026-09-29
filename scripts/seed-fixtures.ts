/**
 * Seeds the portal from the DOGFOOD fixtures (fixtures.json), so every judge sees the same data:
 * 1 event, 8 tracks, 30 judges, 40 teams, 41 projects, 126 scores. Idempotent: a second run
 * changes nothing.
 *
 * The fixture's awkward cases are kept as they are: a judge who gives everyone 4/4/4, judges with
 * one or two reviews, and a duplicate submission (prj_41 resubmits prj_07 for the same team). The
 * schema allows one project per team, so the later submission, prj_41, is the one imported; the
 * earlier one's reviews are reported and skipped.
 *
 * Demo mode also creates four fixed sessions, printed at startup, for the organizers' checker
 * (run.py) and for anyone trying the roles: organizer, judge A, judge B and a participant. They
 * are published in .dogfood.toml, so never run demo mode on an instance with real data.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { migrate, run, get, tx, nowIso } from "../lib/db/client.ts";
import { newId } from "../lib/ids.ts";
import { hashPassword } from "../lib/auth/password.ts";

export const EVENT_SLUG = "sample-hack-2026";
export const DEMO_PASSWORD = "forgeboard2026";
export const DEMO_SESSIONS = {
  organizer: "org_demo_7f2a9c41d8e3b6a5",
  judge_a: "jdg_a_demo_91bc5e0f27d4a8c3",
  judge_b: "jdg_b_demo_44de83a1c9f06b72",
  participant: "prt_demo_2e88b7d14c6f3a19",
} as const;
/** judge A has the most reviews; judge B shares no project with judge A. */
const JUDGE_A = "jdg_24";
const JUDGE_B = "jdg_29";
const PARTICIPANT_EMAIL = "priya1@example.org";

type Fixture = {
  event: { id: string; name: string; submissions_close: string };
  tracks: { id: string; name: string }[];
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: { id: string; team: string; track: string; title: string; summary: string; repo_url: string; submitted_at: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number>; comment: string }[];
};

const file = process.env.FORGEBOARD_FIXTURES ?? path.join(process.cwd(), "fixtures.json");
const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

migrate();

function printLogins() {
  console.log("[forgeboard] seeded. test logins (published in .dogfood.toml; demo only):");
  for (const [role, token] of Object.entries(DEMO_SESSIONS)) console.log(`  ${role.padEnd(12)} Cookie: forgeboard_session=${token}`);
  console.log(`[forgeboard] demo accounts sign in with password "${DEMO_PASSWORD}"`);
}

if (get(`SELECT id FROM events WHERE slug = ?`, EVENT_SLUG)) {
  console.log(`[forgeboard] fixtures already imported (${EVENT_SLUG}); nothing to do.`);
  printLogins();
  process.exit(0);
}

const now = nowIso();
const { hash, salt } = hashPassword(DEMO_PASSWORD);
const users = new Map<string, string>(); // email (lowercase) -> user id

function user(email: string, name: string, id = newId("usr"), role: "admin" | "user" = "user"): string {
  const key = email.toLowerCase();
  const existing = users.get(key);
  if (existing) return existing;
  run(
    `INSERT INTO users (id, email, email_ci, password_hash, password_salt, display_name, global_role, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, email, key, hash, salt, name.slice(0, 80), role, now, now,
  );
  users.set(key, id);
  return id;
}
const nameFromEmail = (email: string) =>
  email.split("@")[0]!.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim().replace(/\b\w/g, (c) => c.toUpperCase()) || email;

const criteriaKeys = [...new Set(fixture.scores.flatMap((s) => Object.keys(s.criteria)))];
const close = new Date(fixture.event.submissions_close).toISOString();
const openedAt = new Date(new Date(close).getTime() - 3 * 864e5).toISOString();

const report = tx(() => {
  const adminId = user("admin@forgeboard.local", "Instance Admin", newId("usr"), "admin");
  const organizerId = user("organizer@forgeboard.local", "Demo Organizer");

  const eventId = fixture.event.id;
  run(
    `INSERT INTO events (id, slug, name, tagline, description, timezone, status,
       submissions_open_at, submissions_close_at, judging_open_at, judging_close_at,
       reviews_per_project, max_team_size, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?, 'UTC', 'judging', ?,?,?,?, 3, 4, ?,?,?)`,
    eventId, EVENT_SLUG, fixture.event.name, "The DOGFOOD fixture event.",
    "Seeded from the DOGFOOD fixtures: every team, project and score is the shared test data.",
    openedAt, close, close, null, organizerId, now, now,
  );
  run(`INSERT INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'organizer', ?,?)`,
    newId("rol"), eventId, organizerId, adminId, now);

  const trackIds = new Map<string, string>();
  fixture.tracks.forEach((t, i) => {
    run(`INSERT INTO tracks (id, event_id, name, slug, description, sort_order) VALUES (?,?,?,?, '', ?)`,
      t.id, eventId, t.name, t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || t.id, i);
    trackIds.set(t.id, t.id);
  });

  const rubricId = newId("rub");
  run(`INSERT INTO rubric_versions (id, event_id, version, name, status, created_by, created_at, published_at)
       VALUES (?,?, 1, 'Rubric', 'published', ?,?,?)`, rubricId, eventId, organizerId, now, now);
  const criterionIds = new Map<string, string>();
  criteriaKeys.forEach((key, i) => {
    const id = newId("crt");
    criterionIds.set(key, id);
    run(`INSERT INTO criteria (id, rubric_version_id, name, description, weight, scale_min, scale_max, sort_order)
         VALUES (?,?,?, '', 1, 1, 5, ?)`, id, rubricId, key[0]!.toUpperCase() + key.slice(1), i);
  });

  for (const j of fixture.judges) {
    const id = user(j.email, j.name, j.id);
    const tracks = j.tracks.length ? j.tracks : [null];
    for (const t of tracks) {
      run(`INSERT INTO event_roles (id, event_id, user_id, role, track_id, granted_by, created_at) VALUES (?,?,?, 'judge', ?,?,?)`,
        newId("rol"), eventId, id, t, organizerId, now);
    }
  }

  // Team names repeat in the fixture (different members); the schema wants unique names per event.
  const seenNames = new Map<string, number>();
  const teamIds = new Map<string, string>();
  for (const t of fixture.teams) {
    const n = (seenNames.get(t.name) ?? 0) + 1;
    seenNames.set(t.name, n);
    const name = n === 1 ? t.name : `${t.name} (${n})`;
    const ownerId = user(t.members[0]!, nameFromEmail(t.members[0]!));
    run(`INSERT INTO teams (id, event_id, name, created_by, created_at) VALUES (?,?,?,?,?)`, t.id, eventId, name, ownerId, now);
    teamIds.set(t.id, t.id);
    t.members.forEach((email, i) => {
      const uid = user(email, nameFromEmail(email));
      run(`INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?,?,?)`, newId("tmm"), t.id, uid, i === 0 ? "owner" : "member", now);
      run(`INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'participant', ?,?)`,
        newId("rol"), eventId, uid, organizerId, now);
    });
  }

  // One project per team: when a team submitted twice, the later submission counts.
  const byTeam = new Map<string, Fixture["projects"][number]>();
  for (const p of fixture.projects) {
    const prev = byTeam.get(p.team);
    if (!prev || p.submitted_at > prev.submitted_at) byTeam.set(p.team, p);
  }
  const kept = new Set([...byTeam.values()].map((p) => p.id));
  const skipped = fixture.projects.filter((p) => !kept.has(p.id)).map((p) => `${p.id} (replaced by ${byTeam.get(p.team)!.id})`);
  for (const p of byTeam.values()) {
    run(
      `INSERT INTO projects (id, event_id, team_id, track_id, name, tagline, description, repo_url, status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?, '', ?, 'submitted', ?,?,?)`,
      p.id, eventId, p.team, trackIds.get(p.track) ?? null, p.title, p.summary, p.repo_url, p.submitted_at, p.submitted_at, p.submitted_at,
    );
  }

  let imported = 0;
  let skippedScores = 0;
  for (const s of fixture.scores) {
    if (!kept.has(s.project)) { skippedScores++; continue; }
    const judgeId = fixture.judges.find((j) => j.id === s.judge)?.id;
    if (!judgeId) { skippedScores++; continue; }
    const assignmentId = newId("asg");
    run(`INSERT INTO assignments (id, event_id, project_id, judge_user_id, status, assigned_by, assigned_at) VALUES (?,?,?,?, 'submitted', ?,?)`,
      assignmentId, eventId, s.project, judgeId, organizerId, now);
    const values = criteriaKeys.map((k) => s.criteria[k]).filter((v): v is number => typeof v === "number");
    const complete = values.length === criteriaKeys.length ? 1 : 0;
    const weighted = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const reviewId = newId("rev");
    run(
      `INSERT INTO reviews (id, assignment_id, rubric_version_id, status, overall_comment, raw_weighted, raw_weighted_100, complete, created_at, updated_at, submitted_at)
       VALUES (?,?,?, 'submitted', ?,?,?,?,?,?,?)`,
      reviewId, assignmentId, rubricId, s.comment ?? "", weighted, weighted === null ? null : ((weighted - 1) / 4) * 100, complete, now, now, now,
    );
    for (const [key, score] of Object.entries(s.criteria)) {
      run(`INSERT INTO criterion_scores (id, review_id, criterion_id, score) VALUES (?,?,?,?)`, newId("csc"), reviewId, criterionIds.get(key)!, score);
    }
    imported++;
  }

  // Demo sessions for the checker and for trying each role.
  const participantId = users.get(PARTICIPANT_EMAIL)!;
  const holders: Record<keyof typeof DEMO_SESSIONS, string> = { organizer: organizerId, judge_a: JUDGE_A, judge_b: JUDGE_B, participant: participantId };
  const expires = new Date(Date.now() + 365 * 864e5).toISOString();
  for (const [role, token] of Object.entries(DEMO_SESSIONS) as [keyof typeof DEMO_SESSIONS, string][]) {
    run(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)`, newId("ses"), holders[role], sha(token), now, expires);
  }
  return { projects: kept.size, teams: fixture.teams.length, judges: fixture.judges.length, scores: imported, skippedScores, skipped };
});

console.log(`[forgeboard] imported ${fixture.event.id} from fixtures.json: ${report.projects} projects, ${report.teams} teams, ${report.judges} judges, ${report.scores} scores`);
if (report.skipped.length) console.log(`[forgeboard]   duplicate submission: ${report.skipped.join(", ")}; ${report.skippedScores} of its reviews not imported`);
printLogins();
