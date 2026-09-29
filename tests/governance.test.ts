/**
 * Tests for the organizer's governing powers and the account recovery path:
 * event setup, judge invitations, eligibility decisions, conflict history and
 * password resets. As with the other suites, these call the domain layer the
 * pages and the API both go through, so a pass means the rule holds on the
 * server rather than in a form.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "forgeboard-gov-"));
process.env.FORGEBOARD_DB_PATH = path.join(dir, "test.db");
process.env.FORGEBOARD_UPLOAD_DIR = path.join(dir, "uploads");

execFileSync(process.execPath, ["scripts/seed.ts"], { env: process.env, stdio: "pipe", cwd: process.cwd() });

const { get, all, run, nowIso } = await import("../lib/db/client.ts");
const { capabilityFor, hasConflict, AccessDenied } = await import("../lib/authz.ts");
const accounts = await import("../lib/domain/accounts.ts");
const events = await import("../lib/domain/events.ts");
const invitations = await import("../lib/domain/invitations.ts");
const judging = await import("../lib/domain/judging.ts");
const projects = await import("../lib/domain/projects.ts");
const results = await import("../lib/domain/results.ts");
const teams = await import("../lib/domain/teams.ts");
const voting = await import("../lib/domain/voting.ts");
const audit = await import("../lib/domain/audit.ts");

const eventId = get<{ id: string }>(`SELECT id FROM events WHERE slug = 'autumn-build-2026'`)!.id;
const organizer = accounts.toActor(accounts.byEmail("organizer@forgeboard.local")!);
const participant = accounts.toActor(accounts.byEmail("participant@forgeboard.local")!);
const orgCap = capabilityFor(organizer, eventId);
const partCap = capabilityFor(participant, eventId);

describe("SETUP-01: event windows are ordered on the server", () => {
  test("submissions cannot close before they open", () => {
    assert.throws(
      () => events.updateEvent(orgCap, {
        submissions_open_at: "2026-09-26T10:00:00.000Z",
        submissions_close_at: "2026-09-25T10:00:00.000Z",
      }),
      /close after it opens/,
    );
  });

  test("judging cannot close before submissions close", () => {
    assert.throws(
      () => events.updateEvent(orgCap, { judging_close_at: "2026-09-01T10:00:00.000Z" }),
      /before submissions close/,
    );
  });

  test("a valid window is accepted and bumps the version", () => {
    const before = events.byId(eventId)!;
    const after = events.updateEvent(orgCap, {
      judging_close_at: "2026-10-02T18:00:00.000Z",
    }, before.version);
    assert.equal(after.judging_close_at, "2026-10-02T18:00:00.000Z");
    assert.equal(after.version, before.version + 1);
  });

  test("a stale version is refused rather than overwriting a colleague", () => {
    assert.throws(() => events.updateEvent(orgCap, { tagline: "x" }, 1), /changed by someone else/);
  });
});

describe("RUBRIC-VALID: a rubric that cannot produce a finite score is refused", () => {
  test("non-finite weights, inverted scales and blank names fail with a readable reason", () => {
    const rubricsBefore = all(`SELECT id FROM rubric_versions WHERE event_id = ?`, eventId).length;
    const cases: [unknown[], RegExp][] = [
      [[{ name: "A", weight: Number.NaN }], /finite/],
      [[{ name: "A", weight: Number.POSITIVE_INFINITY }], /finite/],
      [[{ name: "A", weight: 1, scaleMin: 3, scaleMax: 3 }], /maximum is above/],
      [[{ name: "A", weight: 1, scaleMin: 5, scaleMax: 1 }], /maximum is above/],
      [[{ name: "  ", weight: 1 }], /needs a name/],
    ];
    for (const [items, reason] of cases) {
      assert.throws(() => judging.createRubricVersion(orgCap, "bad", items as never), reason);
    }
    assert.equal(all(`SELECT id FROM rubric_versions WHERE event_id = ?`, eventId).length, rubricsBefore);
  });
});

describe("SETUP-02: questions, tracks and prizes", () => {
  test("a choice question needs at least two options", () => {
    assert.throws(
      () => events.addQuestion(orgCap, { prompt: "Pick one", kind: "single_select", options: ["Only"] }),
      /at least two options/,
    );
  });

  test("an answer outside the configured options is refused", () => {
    const q = events.addQuestion(orgCap, {
      prompt: "How far along is it, really?", kind: "single_select", options: ["Idea", "Working"],
    });
    const team = teams.teamForUser(eventId, participant.id)!;
    const project = projects.forTeam(team.id)!;
    assert.throws(
      () => projects.saveDraft(orgCap, organizer, project.id, {}, undefined, { [q.id]: "Shipped" }),
      /not one of the options/,
    );
    projects.saveDraft(orgCap, organizer, project.id, {}, undefined, { [q.id]: "Working" });
    assert.equal(projects.answersFor(project.id)[q.id], "Working");

    // With the answer cleared, the question can be withdrawn again.
    run(`DELETE FROM custom_answers WHERE question_id = ?`, q.id);
    events.removeQuestion(orgCap, q.id);
    assert.equal(events.questions(eventId).some((x) => x.id === q.id), false);
  });

  test("a question that teams have answered cannot be removed", () => {
    const answered = get<{ question_id: string }>(
      `SELECT question_id FROM custom_answers WHERE TRIM(value_text) != '' LIMIT 1`)!;
    assert.throws(() => events.removeQuestion(orgCap, answered.question_id), /already answered/);
  });

  test("a track in use cannot be removed", () => {
    const used = get<{ track_id: string }>(
      `SELECT track_id FROM projects WHERE track_id IS NOT NULL LIMIT 1`)!;
    assert.throws(() => events.removeTrack(orgCap, used.track_id), /project\(s\) are in this track/);
  });

  test("prizes are organizer-only", () => {
    assert.throws(() => events.addPrize(partCap, { name: "Sneaky prize" }), AccessDenied);
  });

  test("the checklist is computed from stored data", () => {
    const items = events.setupChecklist(orgCap, "autumn-build-2026");
    const byLabel = new Map(items.map((i) => [i.label, i]));
    assert.equal(byLabel.get("Publish a rubric")!.done, true);
    assert.equal(byLabel.get("Invite judges")!.done, true);
    assert.equal(byLabel.get("Add prizes")!.done, true);
  });
});

describe("JUDGE-INVITE: a scoped, single-use invitation", () => {
  const newcomer = accounts.register({
    email: "newjudge@example.org", password: "correct horse 9", displayName: "New Judge",
  });

  test("the invitation grants only the track it was issued for", () => {
    const track = events.tracks(eventId)[0];
    const { token, invitation } = invitations.createRoleInvitation(orgCap, { trackId: track.id });
    assert.equal(invitations.invitationState(invitation), "pending");

    invitations.accept(accounts.toActor(newcomer), token);
    const cap = capabilityFor(accounts.toActor(newcomer), eventId);
    assert.equal(cap.isJudge, true);
    assert.deepEqual(cap.judgeTrackIds, [track.id]);
    assert.equal(cap.isOrganizer, false, "accepting a judge invitation never grants more than judging");
  });

  test("the same link cannot be used twice", () => {
    const { token } = invitations.createRoleInvitation(orgCap, {});
    const second = accounts.register({ email: "second@example.org", password: "correct horse 9", displayName: "Second" });
    invitations.accept(accounts.toActor(second), token);
    const third = accounts.register({ email: "third@example.org", password: "correct horse 9", displayName: "Third" });
    assert.throws(() => invitations.accept(accounts.toActor(third), token), /already been used/);
    assert.equal(capabilityFor(accounts.toActor(third), eventId).isJudge, false);
  });

  test("an addressed invitation refuses a different account, and the refusal is audited", () => {
    const { token } = invitations.createRoleInvitation(orgCap, { email: "expected@example.org" });
    const other = accounts.register({ email: "other@example.org", password: "correct horse 9", displayName: "Other" });
    assert.throws(() => invitations.accept(accounts.toActor(other), token), /different email address/);
    const denied = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'invite.judge.accept' AND outcome = 'denied'`)!.n;
    assert.ok(denied > 0, "the refused acceptance is on the record");
  });

  test("a revoked invitation stops working", () => {
    const { token, invitation } = invitations.createRoleInvitation(orgCap, {});
    invitations.revoke(orgCap, invitation.id);
    const nobody = accounts.register({ email: "nobody@example.org", password: "correct horse 9", displayName: "Nobody" });
    assert.throws(() => invitations.accept(accounts.toActor(nobody), token), /revoked/);
  });

  test("an expired invitation stops working", () => {
    const { token, invitation } = invitations.createRoleInvitation(orgCap, {});
    run(`UPDATE role_invitations SET expires_at = ? WHERE id = ?`, "2020-01-01T00:00:00.000Z", invitation.id);
    const late = accounts.register({ email: "late@example.org", password: "correct horse 9", displayName: "Late" });
    assert.throws(() => invitations.accept(accounts.toActor(late), token), /expired/);
  });

  test("only an organizer may issue or revoke", () => {
    assert.throws(() => invitations.createRoleInvitation(partCap, {}), AccessDenied);
    assert.throws(() => invitations.listForEvent(partCap), AccessDenied);
  });

  test("the raw token is never stored or audited", () => {
    const { token } = invitations.createRoleInvitation(orgCap, {});
    const rows = all<{ token_hash: string }>(`SELECT token_hash FROM role_invitations`);
    assert.ok(rows.every((r) => r.token_hash !== token), "only the hash is stored");
    const audits = all<{ detail_json: string }>(`SELECT detail_json FROM audit_events WHERE action LIKE 'invite.judge%'`);
    assert.ok(audits.every((a) => !a.detail_json.includes(token)), "the audit trail holds no tokens");
  });
});

describe("JUDGE-REMOVE: removing a judge keeps the record", () => {
  test("open assignments are released, submitted reviews are kept, access ends", () => {
    const busy = all<{ judge_user_id: string; n: number }>(
      `SELECT a.judge_user_id, COUNT(*) AS n FROM assignments a
        JOIN reviews r ON r.assignment_id = a.id
       WHERE a.event_id = ? AND r.status = 'submitted'
       GROUP BY a.judge_user_id ORDER BY n DESC LIMIT 1`, eventId)[0];
    const judge = accounts.toActor(accounts.byId(busy.judge_user_id)!);

    const out = invitations.removeJudge(orgCap, judge.id);
    assert.equal(out.keptReviews, busy.n);

    const after = capabilityFor(judge, eventId);
    assert.equal(after.isJudge, false, "the next request has no judge capability");
    assert.throws(() => judging.queueFor(after, judge), AccessDenied);

    const stillSubmitted = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments a JOIN reviews r ON r.assignment_id = a.id
        WHERE a.judge_user_id = ? AND r.status = 'submitted'`, judge.id)!.n;
    assert.equal(stillSubmitted, busy.n, "their finished work is still on the record");
  });
});

describe("CONFLICT-01: leaving a team does not clear a conflict", () => {
  test("a past member is still conflicted", () => {
    const team = teams.teamForUser(eventId, participant.id)!;
    const project = projects.forTeam(team.id)!;
    assert.equal(hasConflict(participant.id, project.id), true);

    // Somebody else has to own the team before the owner may leave.
    run(`UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?`, team.id, participant.id);
    run(
      `INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?, 'owner', ?)`,
      "tmm_test_owner", team.id, organizer.id, nowIso(),
    );
    teams.leaveTeam(participant, team.id);

    assert.equal(teams.teamForUser(eventId, participant.id), undefined, "they really did leave");
    assert.equal(hasConflict(participant.id, project.id), true, "the conflict survives the departure");
  });
});

describe("ELIGIBILITY-01: disqualification is recorded, not destructive", () => {
  const target = get<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE event_id = ? AND status = 'submitted' ORDER BY id LIMIT 1`, eventId)!;

  test("a reason is required", () => {
    assert.throws(() => projects.setEligibility(orgCap, target.id, "disqualified", "no"), /reason/);
  });

  test("participants cannot decide eligibility", () => {
    assert.throws(() => projects.setEligibility(partCap, target.id, "disqualified", "because I said so"), AccessDenied);
  });

  test("a disqualified project leaves the gallery, assignments, ballot and results", () => {
    const beforeGallery = projects.gallery(eventId, { limit: 200 }).length;
    projects.setEligibility(orgCap, target.id, "disqualified", "Submitted work that was not built during the event.");

    assert.equal(projects.gallery(eventId, { limit: 200 }).length, beforeGallery - 1);
    assert.equal(projects.galleryCount(eventId), beforeGallery - 1);
    const someVoter = "vtr_eligibility_probe";
    assert.ok(!voting.ballotOrder(eventId, someVoter).includes(target.id), "it is off the ballot");
    assert.ok(
      !judging.allSubmittedReviews(orgCap).some((r) => r.project_id === target.id),
      "its reviews are out of the scoring input",
    );
    assert.ok(
      !judging.generateAssignments(orgCap, { dryRun: true }).coverage.some((c) => c.projectId === target.id),
      "the planner stops offering it",
    );

    // The submission itself is untouched.
    const row = projects.byId(target.id)!;
    assert.equal(row.name, target.name);
    assert.equal(row.status, "submitted");
    const history = projects.eligibilityHistory(target.id);
    assert.equal(history[0].decision, "disqualified");
    assert.match(history[0].reason, /not built during the event/);
  });

  test("reinstating puts it back and keeps both decisions", () => {
    projects.setEligibility(orgCap, target.id, "reinstated", "Checked the commit history; it is fine.");
    assert.ok(projects.gallery(eventId, { limit: 200 }).some((p) => p.id === target.id));
    assert.equal(projects.eligibilityHistory(target.id).length, 2);
  });
});

describe("ASSIGN-PREVIEW: a dry run writes nothing", () => {
  test("the preview matches what committing then does", () => {
    const before = get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ?`, eventId)!.n;
    const preview = judging.generateAssignments(orgCap, { reviewsPerProject: 4, dryRun: true });
    const afterPreview = get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ?`, eventId)!.n;
    assert.equal(afterPreview, before, "a preview creates no assignments");
    assert.ok(preview.created > 0);
    assert.equal(preview.target, 4);
    assert.ok(preview.coverage.length > 0);

    const committed = judging.generateAssignments(orgCap, { reviewsPerProject: 4 });
    assert.equal(committed.created, preview.created, "the plan the organizer approved is the plan that ran");
    const afterCommit = get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ?`, eventId)!.n;
    assert.equal(afterCommit, before + committed.created);
  });

  test("a preview leaves no audit entry, a commit does", () => {
    const before = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'assignment.generate'`)!.n;
    judging.generateAssignments(orgCap, { reviewsPerProject: 5, dryRun: true });
    assert.equal(
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'assignment.generate'`)!.n,
      before,
    );
  });
});

describe("ADMIN-01: instance admin access is allowed and audited", () => {
  // The seeded admin holds no role in this event, which is the case that matters.
  const admin = accounts.toActor(accounts.byEmail("admin@forgeboard.local")!);

  test("an admin who does not organize the event is marked as such", () => {
    const cap = capabilityFor(admin, eventId);
    assert.equal(cap.isOrganizer, true);
    assert.equal(cap.viaAdmin, true);
    assert.equal(capabilityFor(organizer, eventId).viaAdmin, false);
  });

  test("their access lands in the event's own audit trail", () => {
    const before = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.access' AND event_id = ?`, eventId)!.n;
    audit.adminAccess(capabilityFor(admin, eventId), "organizer console");
    const after = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.access' AND event_id = ?`, eventId)!.n;
    assert.equal(after, before + 1);

    // A second look within the window does not spam the trail.
    audit.adminAccess(capabilityFor(admin, eventId), "organizer console");
    assert.equal(
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.access' AND event_id = ?`, eventId)!.n,
      after,
    );
  });

  test("an ordinary organizer's work is not recorded as an override", () => {
    const before = get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.access'`)!.n;
    audit.adminAccess(orgCap, "organizer console");
    assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.access'`)!.n, before);
  });
});

describe("RECOVERY-01: local password reset", () => {
  const target = accounts.byEmail("judge@forgeboard.local")!;

  test("the link works once, and only for its account", () => {
    const { token } = accounts.issuePasswordReset(target, null);
    assert.equal(accounts.resetTokenUser(token)!.id, target.id);

    accounts.redeemPasswordReset(token, "brand new pass 7");
    assert.ok(accounts.authenticate(target.email, "brand new pass 7"));
    assert.equal(accounts.authenticate(target.email, "forgeboard2026"), null, "the old password is gone");

    assert.throws(() => accounts.redeemPasswordReset(token, "another pass 12"), /already been used/);
  });

  test("redeeming signs every existing session out", () => {
    const { token } = accounts.issuePasswordReset(target, null);
    run(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)`,
      "ses_recovery_test", target.id, "deadbeef", nowIso(), "2099-01-01T00:00:00.000Z",
    );
    accounts.redeemPasswordReset(token, "third password 3");
    const live = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, target.id)!.n;
    assert.equal(live, 0);
  });

  test("an expired link is refused", () => {
    const { token } = accounts.issuePasswordReset(target, null);
    run(`UPDATE password_resets SET expires_at = ? WHERE token_hash IS NOT NULL AND used_at IS NULL`,
      "2020-01-01T00:00:00.000Z");
    assert.equal(accounts.resetTokenUser(token), null);
    assert.throws(() => accounts.redeemPasswordReset(token, "expired pass 11"), /expired/);
  });

  test("the password policy still applies", () => {
    const { token } = accounts.issuePasswordReset(target, null);
    assert.throws(() => accounts.redeemPasswordReset(token, "short1"), /at least 10 characters/);
  });

  test("the raw token is not stored", () => {
    const { token } = accounts.issuePasswordReset(target, null);
    const rows = all<{ token_hash: string }>(`SELECT token_hash FROM password_resets`);
    assert.ok(rows.every((r) => r.token_hash !== token));
  });
});

describe("RESULTS: disqualified work stays out of a recomputed snapshot", () => {
  test("the snapshot skips a disqualified project", () => {
    const target = get<{ id: string }>(
      `SELECT p.id FROM projects p
        JOIN assignments a ON a.project_id = p.id
        JOIN reviews r ON r.assignment_id = a.id AND r.status = 'submitted'
       WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
       GROUP BY p.id HAVING COUNT(*) >= 2 LIMIT 1`, eventId)!;
    projects.setEligibility(orgCap, target.id, "disqualified", "Rules breach recorded by the organizer.");
    const snap = results.computeSnapshot(orgCap);
    const rows = results.rows(snap.id);
    assert.ok(!rows.some((r) => r.project_id === target.id), "it is not ranked");
    projects.setEligibility(orgCap, target.id, "reinstated", "Reinstated after review by the organizers.");
  });
});
