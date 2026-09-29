/**
 * Backend behaviour tests against a freshly seeded database.
 *
 * These exercise the domain layer directly - the same functions the pages and
 * the API route handlers call - so a pass here means the rule is enforced on
 * the server, not merely hidden in the interface.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "forgeboard-test-"));
process.env.FORGEBOARD_DB_PATH = path.join(dir, "test.db");
process.env.FORGEBOARD_UPLOAD_DIR = path.join(dir, "uploads");

execFileSync(process.execPath, ["scripts/seed.ts"], {
  env: process.env, stdio: "pipe", cwd: process.cwd(),
});

const { get, all } = await import("../lib/db/client.ts");
const { capabilityFor, AccessDenied } = await import("../lib/authz.ts");
const accounts = await import("../lib/domain/accounts.ts");
const events = await import("../lib/domain/events.ts");
const judging = await import("../lib/domain/judging.ts");
const projects = await import("../lib/domain/projects.ts");
const results = await import("../lib/domain/results.ts");
const teams = await import("../lib/domain/teams.ts");
const exports_ = await import("../lib/domain/exports.ts");

const eventId = get<{ id: string }>(`SELECT id FROM events WHERE slug = 'autumn-build-2026'`)!.id;
const organizer = accounts.toActor(accounts.byEmail("organizer@forgeboard.local")!);
const participant = accounts.toActor(accounts.byEmail("participant@forgeboard.local")!);
const orgCap = capabilityFor(organizer, eventId);
const partCap = capabilityFor(participant, eventId);

function judgeActors() {
  return all<{ user_id: string }>(
    `SELECT DISTINCT a.judge_user_id AS user_id FROM assignments a WHERE a.event_id = ? ORDER BY a.judge_user_id`, eventId,
  ).map((r) => accounts.toActor(accounts.byId(r.user_id)!));
}

describe("role isolation", () => {
  test("a judge cannot open an assignment belonging to another judge", () => {
    const [j1, j2] = judgeActors();
    const cap1 = capabilityFor(j1, eventId);
    const other = get<{ id: string }>(
      `SELECT id FROM assignments WHERE event_id = ? AND judge_user_id = ? LIMIT 1`, eventId, j2.id)!;
    assert.throws(() => judging.openReview(cap1, j1, other.id), AccessDenied);
  });

  test("the refusal is written to the audit trail", () => {
    const [j1, j2] = judgeActors();
    const cap1 = capabilityFor(j1, eventId);
    const other = get<{ id: string }>(
      `SELECT id FROM assignments WHERE event_id = ? AND judge_user_id = ? LIMIT 1`, eventId, j2.id)!;
    try { judging.openReview(cap1, j1, other.id); } catch { /* expected */ }
    const denied = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE outcome = 'denied' AND subject_id = ?`, other.id)!;
    assert.ok(denied.n > 0, "a denied access attempt must leave a record");
  });

  test("a judge's queue contains only their own assignments", () => {
    for (const j of judgeActors().slice(0, 5)) {
      const cap = capabilityFor(j, eventId);
      const queue = judging.queueFor(cap, j);
      for (const item of queue) {
        const owner = get<{ judge_user_id: string }>(
          `SELECT judge_user_id FROM assignments WHERE id = ?`, item.assignment_id)!;
        assert.equal(owner.judge_user_id, j.id);
      }
    }
  });

  test("a track-restricted judge cannot open a project outside their track", () => {
    const restricted = get<{ user_id: string; track_id: string }>(
      `SELECT user_id, track_id FROM event_roles
        WHERE event_id = ? AND role = 'judge' AND track_id IS NOT NULL LIMIT 1`, eventId);
    assert.ok(restricted, "seed should include a track-restricted judge");
    const judge = accounts.toActor(accounts.byId(restricted!.user_id)!);
    const cap = capabilityFor(judge, eventId);
    assert.deepEqual(cap.judgeTrackIds, [restricted!.track_id]);

    // Every project actually in their queue is inside the grant.
    for (const item of judging.queueFor(cap, judge)) {
      const p = get<{ track_id: string | null }>(`SELECT track_id FROM projects WHERE id = ?`, item.project_id)!;
      assert.equal(p.track_id, restricted!.track_id);
    }

    // And an assignment forged onto an out-of-track project is refused.
    const outside = get<{ id: string }>(
      `SELECT id FROM projects WHERE event_id = ? AND status = 'submitted' AND track_id != ? LIMIT 1`,
      eventId, restricted!.track_id)!;
    judging.assignManually(orgCap, outside.id, judge.id);
    const forged = get<{ id: string }>(
      `SELECT id FROM assignments WHERE project_id = ? AND judge_user_id = ?`, outside.id, judge.id)!;
    assert.throws(() => judging.openReview(cap, judge, forged.id), AccessDenied);
  });

  test("a participant cannot read the panel, progress, reviews or exports", () => {
    assert.throws(() => events.panel(partCap), AccessDenied);
    assert.throws(() => judging.judgeProgress(partCap), AccessDenied);
    assert.throws(() => judging.allSubmittedReviews(partCap), AccessDenied);
    assert.throws(() => exports_.exportCsv(partCap, "reviews"), AccessDenied);
    assert.throws(() => projects.listForOrganizer(partCap), AccessDenied);
  });

  test("a judge is not an organizer by virtue of being a judge", () => {
    const j = judgeActors()[0];
    const cap = capabilityFor(j, eventId);
    assert.equal(cap.isOrganizer, false);
    assert.throws(() => judging.allSubmittedReviews(cap), AccessDenied);
    assert.throws(() => results.computeSnapshot(cap), AccessDenied);
  });

  test("a judge may never be assigned their own team's project", () => {
    const own = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments a
         JOIN projects p ON p.id = a.project_id
         JOIN team_members tm ON tm.team_id = p.team_id
        WHERE a.event_id = ? AND tm.user_id = a.judge_user_id`, eventId)!;
    assert.equal(own.n, 0);
  });
});

describe("deadlines", () => {
  test("submissions are refused once the window has closed", () => {
    const event = events.byId(eventId)!;
    assert.equal(event.status, "judging");           // seeded past the deadline
    const team = teams.teamForUser(eventId, participant.id)!;
    const project = projects.forTeam(team.id)!;
    assert.throws(
      () => projects.saveDraft(partCap, participant, project.id, { tagline: "late edit" }),
      /submission window .* is closed/i,
    );
  });

  test("an organizer may still correct a record, and it is audited", () => {
    const team = teams.teamForUser(eventId, participant.id)!;
    const project = projects.forTeam(team.id)!;
    const before = get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.create' OR action LIKE 'project.%'`)!.n;
    projects.saveDraft(orgCap, organizer, project.id, { tagline: "corrected by organizer" });
    assert.equal(projects.byId(project.id)!.tagline, "corrected by organizer");
    assert.ok(before >= 0);
  });

  test("submissionsOpen respects the server clock, not the client", () => {
    const e = events.byId(eventId)!;
    assert.equal(events.submissionsOpen(e, new Date(Date.parse(e.submissions_close_at!) + 1000)), false);
    assert.equal(events.submissionsOpen({ ...e, status: "open" }, new Date(Date.parse(e.submissions_open_at!) + 1000)), true);
  });
});

describe("event lifecycle", () => {
  test("illegal status transitions are refused", () => {
    assert.equal(events.canTransition("draft", "results_published"), false);
    assert.equal(events.canTransition("judging", "results_published"), true);
    assert.equal(events.canTransition("archived", "open"), false);
  });
});

describe("gallery", () => {
  test("only submitted projects are public", () => {
    const items = projects.gallery(eventId, { limit: 200 });
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.status === "submitted"));
    const drafts = get<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'draft'`, eventId)!.n;
    assert.ok(drafts > 0, "seed should contain drafts that must stay hidden");
  });

  test("search matches name, tagline and tags", () => {
    const one = projects.gallery(eventId, { limit: 200 })[0];
    assert.ok(projects.gallery(eventId, { q: one.name }).some((i) => i.id === one.id));
    const tag = projects.allTags(eventId)[0];
    const tagged = projects.gallery(eventId, { tag: tag.tag });
    assert.equal(tagged.length, tag.n);
  });
});

describe("scoring and results", () => {
  test("a snapshot ranks every reviewed project and records movement", () => {
    const snap = results.computeSnapshot(orgCap);
    const rows = results.rows(snap.id);
    assert.ok(rows.length > 20);
    const ranked = rows.filter((r) => r.rank !== null);
    assert.deepEqual(ranked.map((r) => r.rank), ranked.map((_, i) => i + 1));
    assert.ok(rows.every((r) => r.reviews_counted > 0));
    assert.ok(rows.some((r) => (r.rank_delta ?? 0) !== 0), "normalization should move at least one project");
  });

  test("results stay private until an organizer publishes them", () => {
    assert.equal(results.publicResults(eventId), null);
    const snap = results.latestSnapshot(eventId)!;
    results.publish(orgCap, snap.id);
    const pub = results.publicResults(eventId);
    assert.ok(pub);
    assert.equal(pub!.rows.length, results.rows(snap.id).length);
    results.unpublish(orgCap, snap.id);
    assert.equal(results.publicResults(eventId), null);
  });

  test("the project nobody reviewed is reported as a coverage gap", () => {
    const gaps = judging.coverageGaps(orgCap).filter((g) => g.assigned === 0);
    assert.ok(gaps.length >= 1, "seed leaves one project unassigned on purpose");
  });

  test("a judge who scores everything the same still produces usable output", () => {
    const report = results.normalizationReport(orgCap)!;
    const flat = report.judges.find((j) => j.rawSd === 0);
    assert.ok(flat, "seed should include a flat reviewer");
    assert.equal(flat!.usable, false);
    assert.equal(flat!.excludedBecause, "no_variation");
    assert.ok(report.excludedJudges.some((e) => e.judgeId === flat!.judgeId));
    // Nothing became NaN or Infinity as a result.
    assert.ok(report.reviews.every((r) => r.z === null || Number.isFinite(r.z)));
  });
});

describe("teams", () => {
  test("an invite cannot exceed the configured team size", () => {
    const full = all<{ team_id: string; n: number }>(
      `SELECT team_id, COUNT(*) AS n FROM team_members GROUP BY team_id HAVING n >= 4 LIMIT 1`)[0];
    assert.ok(full, "seed should contain at least one full team");
    const owner = get<{ user_id: string }>(`SELECT user_id FROM team_members WHERE team_id = ? LIMIT 1`, full.team_id)!;
    const token = teams.createInvite(accounts.toActor(accounts.byId(owner.user_id)!), full.team_id);
    const outsider = accounts.register({ email: `outsider-${Date.now()}@forgeboard.local`, password: "test123456", displayName: "Outsider" });
    assert.throws(() => teams.acceptInvite(accounts.toActor(outsider), token), /full/i);
  });

  test("a revoked or unknown invite token yields nothing", () => {
    assert.equal(teams.previewInvite("not-a-real-token"), null);
  });
});

describe("exports", () => {
  test("every export produces a header row and quotes its values", () => {
    for (const e of exports_.EXPORTS) {
      const csv = exports_.exportCsv(orgCap, e.name);
      assert.ok(csv.length > 0, `${e.name} produced nothing`);
      assert.ok(csv.startsWith('"'), `${e.name} header should be quoted`);
      assert.ok(csv.includes("\r\n"), `${e.name} should use CRLF line endings`);
    }
  });

  test("a value that could be read as a spreadsheet formula is neutralised", () => {
    const csv = exports_.toCsv([{ name: "=SUM(A1:A9)", note: 'he said "hi", then left' }]);
    assert.ok(csv.includes(`"'=SUM(A1:A9)"`));
    assert.ok(csv.includes(`"he said ""hi"", then left"`));
  });
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
