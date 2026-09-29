import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId, slugify } from "../ids.ts";
import { requireOrganizer, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import { weightedScore, weightedScore100, isComplete, type CriterionWeight } from "./scoring.ts";

export const BUNDLE_VERSION = "forgeboard.bundle/1";

/**
 * A whole-event bundle: stable ids, a schema version, and everything needed to
 * reconstruct the event elsewhere. Deliberately excludes password hashes,
 * sessions and raw invitation tokens — a portability file is not a credential
 * dump. People are exported by email, which is the natural join key on import.
 */
export type Bundle = {
  version: string;
  exported_at: string;
  event: Record<string, unknown>;
  people: { email: string; display_name: string }[];
  tracks: Record<string, unknown>[];
  prizes: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  roles: { email: string; role: string; track_id: string | null }[];
  teams: { id: string; name: string; members: { email: string; role: string }[] }[];
  projects: Record<string, unknown>[];
  tags: { project_id: string; tag: string }[];
  answers: Record<string, unknown>[];
  rubrics: { rubric: Record<string, unknown>; criteria: Record<string, unknown>[] }[];
  assignments: { id: string; project_id: string; judge_email: string; status: string; batch_label: string }[];
  reviews: {
    id: string; assignment_id: string; rubric_version_id: string; status: string;
    overall_comment: string; raw_weighted: number | null; raw_weighted_100: number | null;
    complete: number; submitted_at: string | null;
    scores: { criterion_id: string; score: number; comment: string }[];
  }[];
};

const SENSITIVE = ["password_hash", "password_salt", "token_hash", "session_hash", "email_ci", "ip_hash"];
function scrub<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const k of SENSITIVE) delete (out as Record<string, unknown>)[k];
  return out;
}

export function exportBundle(cap: Capability): Bundle {
  requireOrganizer(cap);
  const e = cap.eventId;
  const event = scrub(get<Record<string, unknown>>(`SELECT * FROM events WHERE id = ?`, e)!);

  const people = all<{ email: string; display_name: string }>(
    `SELECT DISTINCT u.email, u.display_name FROM users u
      WHERE u.id IN (SELECT user_id FROM event_roles WHERE event_id = ?)
         OR u.id IN (SELECT tm.user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.event_id = ?)`,
    e, e);

  const teams = all<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE event_id = ?`, e)
    .map((t) => ({
      ...t,
      members: all<{ email: string; role: string }>(
        `SELECT u.email, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`, t.id),
    }));

  const rubrics = all<Record<string, unknown>>(`SELECT * FROM rubric_versions WHERE event_id = ?`, e)
    .map((r) => ({
      rubric: scrub(r),
      criteria: all<Record<string, unknown>>(`SELECT * FROM criteria WHERE rubric_version_id = ?`, r.id as string),
    }));

  const reviews = all<Record<string, unknown>>(
    `SELECT r.* FROM reviews r JOIN assignments a ON a.id = r.assignment_id WHERE a.event_id = ?`, e,
  ).map((r) => ({
    id: r.id as string,
    assignment_id: r.assignment_id as string,
    rubric_version_id: r.rubric_version_id as string,
    status: r.status as string,
    overall_comment: r.overall_comment as string,
    raw_weighted: r.raw_weighted as number | null,
    raw_weighted_100: r.raw_weighted_100 as number | null,
    complete: r.complete as number,
    submitted_at: r.submitted_at as string | null,
    scores: all<{ criterion_id: string; score: number; comment: string }>(
      `SELECT criterion_id, score, comment FROM criterion_scores WHERE review_id = ?`, r.id as string),
  }));

  const bundle: Bundle = {
    version: BUNDLE_VERSION,
    exported_at: nowIso(),
    event,
    people,
    tracks: all(`SELECT * FROM tracks WHERE event_id = ?`, e),
    prizes: all(`SELECT * FROM prizes WHERE event_id = ?`, e),
    questions: all(`SELECT * FROM custom_questions WHERE event_id = ?`, e),
    roles: all<{ email: string; role: string; track_id: string | null }>(
      `SELECT u.email, r.role, r.track_id FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ?`, e),
    teams,
    projects: all<Record<string, unknown>>(`SELECT * FROM projects WHERE event_id = ?`, e).map(scrub),
    tags: all(`SELECT pt.project_id, pt.tag FROM project_tags pt JOIN projects p ON p.id = pt.project_id WHERE p.event_id = ?`, e),
    answers: all(`SELECT ca.* FROM custom_answers ca JOIN projects p ON p.id = ca.project_id WHERE p.event_id = ?`, e),
    rubrics,
    assignments: all<{ id: string; project_id: string; judge_email: string; status: string; batch_label: string }>(
      `SELECT a.id, a.project_id, u.email AS judge_email, a.status, a.batch_label
         FROM assignments a JOIN users u ON u.id = a.judge_user_id WHERE a.event_id = ?`, e),
    reviews,
  };

  audit.record({
    actor: cap.actor, eventId: e, action: "bundle.export", subjectType: "event", subjectId: e,
    detail: { projects: bundle.projects.length, reviews: bundle.reviews.length },
  });
  return bundle;
}

export type ImportProblem = { path: string; message: string };
export type ImportReport = {
  ok: boolean;
  dryRun: boolean;
  problems: ImportProblem[];
  counts: Record<string, number>;
  eventSlug?: string;
};

function validate(raw: unknown): { bundle: Bundle | null; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { bundle: null, problems: [{ path: "", message: "The file is not a JSON object." }] };
  }
  const b = raw as Partial<Bundle>;
  if (b.version !== BUNDLE_VERSION) {
    problems.push({ path: "version", message: `Expected schema version "${BUNDLE_VERSION}", found "${String(b.version)}".` });
  }
  for (const key of ["event", "people", "teams", "projects", "rubrics", "assignments", "reviews"] as const) {
    if (b[key] === undefined) problems.push({ path: key, message: `Missing "${key}".` });
  }
  if (b.event && typeof (b.event as Record<string, unknown>).name !== "string") {
    problems.push({ path: "event.name", message: "The event needs a name." });
  }
  // Referential checks before anything is written.
  const teamIds = new Set((b.teams ?? []).map((t) => t.id));
  for (const p of (b.projects ?? []) as Record<string, unknown>[]) {
    if (!teamIds.has(p.team_id as string)) {
      problems.push({ path: `projects.${p.id}`, message: `References team ${String(p.team_id)}, which is not in the file.` });
    }
  }
  const projectIds = new Set((b.projects ?? []).map((p) => (p as Record<string, unknown>).id as string));
  for (const a of b.assignments ?? []) {
    if (!projectIds.has(a.project_id)) {
      problems.push({ path: `assignments.${a.id}`, message: `References project ${a.project_id}, which is not in the file.` });
    }
  }
  // Criteria must be scoreable, and every imported score must sit on its
  // criterion's scale. A file is not trusted to be internally consistent.
  const criteriaById = new Map<string, Record<string, unknown>>();
  const rubricOfCriterion = new Map<string, string>();
  for (const r of b.rubrics ?? []) {
    const rubricId = (r.rubric as Record<string, unknown>)?.id as string;
    for (const c of (r.criteria ?? []) as Record<string, unknown>[]) {
      const weight = c.weight ?? 1, lo = c.scale_min ?? 1, hi = c.scale_max ?? 5;
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
        problems.push({ path: `rubrics.${rubricId}.criteria.${String(c.id)}`, message: "Weight must be a finite number of zero or more." });
      }
      if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        problems.push({ path: `rubrics.${rubricId}.criteria.${String(c.id)}`, message: "Scale maximum must be above its minimum." });
      }
      criteriaById.set(c.id as string, c);
      rubricOfCriterion.set(c.id as string, rubricId);
    }
  }
  const assignmentIds = new Set((b.assignments ?? []).map((a) => a.id));
  for (const r of b.reviews ?? []) {
    if (!assignmentIds.has(r.assignment_id)) {
      problems.push({ path: `reviews.${r.id}`, message: `References assignment ${r.assignment_id}, which is not in the file.` });
    }
    for (const s of r.scores ?? []) {
      const c = criteriaById.get(s.criterion_id);
      if (!c || rubricOfCriterion.get(s.criterion_id) !== r.rubric_version_id) {
        problems.push({ path: `reviews.${r.id}.scores.${s.criterion_id}`, message: "Scores a criterion that is not in this review's rubric." });
        continue;
      }
      const lo = (c.scale_min ?? 1) as number, hi = (c.scale_max ?? 5) as number;
      if (typeof s.score !== "number" || !Number.isFinite(s.score) || s.score < lo || s.score > hi) {
        problems.push({ path: `reviews.${r.id}.scores.${s.criterion_id}`, message: `Score ${String(s.score)} is outside ${lo}–${hi}.` });
      }
    }
  }
  return { bundle: problems.length ? null : (b as Bundle), problems };
}

/**
 * Imports a bundle as a NEW event owned by the importer.
 *
 * All-or-nothing: the whole thing runs inside one transaction, and any failure
 * rolls the lot back. Re-importing the same file creates a separate event
 * rather than duplicating rows into the old one, so a repeated import cannot
 * double-count reviews or memberships.
 *
 * Accounts are matched by email and created disabled if absent — an import must
 * not mint usable logins for people who never registered here.
 */
export function importBundle(actor: Actor, raw: unknown, opts: { dryRun: boolean }): ImportReport {
  const { bundle, problems } = validate(raw);
  if (!bundle) return { ok: false, dryRun: opts.dryRun, problems, counts: {} };

  const counts: Record<string, number> = {
    people: bundle.people.length, teams: bundle.teams.length,
    projects: bundle.projects.length, assignments: bundle.assignments.length,
    reviews: bundle.reviews.length,
  };
  if (opts.dryRun) return { ok: true, dryRun: true, problems: [], counts };

  const now = nowIso();
  const src = bundle.event as Record<string, unknown>;

  const slug = tx(() => {
    let slug = slugify(`${src.name as string}-imported`, "imported-event");
    if (get(`SELECT id FROM events WHERE slug = ?`, slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const eventId = newId("evt");

    run(
      `INSERT INTO events (id, slug, name, tagline, description, timezone, status,
         submissions_open_at, submissions_close_at, judging_open_at, judging_close_at,
         reviews_per_project, max_team_size, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'draft', ?,?,?,?,?,?,?,?,?)`,
      eventId, slug, src.name, src.tagline ?? "", src.description ?? "", src.timezone ?? "UTC",
      src.submissions_open_at ?? null, src.submissions_close_at ?? null,
      src.judging_open_at ?? null, src.judging_close_at ?? null,
      src.reviews_per_project ?? 3, src.max_team_size ?? 4, actor.id, now, now,
    );
    run(`INSERT INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'organizer', ?,?)`,
      newId("rol"), eventId, actor.id, actor.id, now);

    // People: matched by email, never given a usable password by an import.
    const userByEmail = new Map<string, string>();
    for (const person of bundle.people) {
      const existing = get<{ id: string }>(`SELECT id FROM users WHERE email_ci = ?`, person.email.toLowerCase());
      if (existing) { userByEmail.set(person.email, existing.id); continue; }
      const id = newId("usr");
      run(
        `INSERT INTO users (id, email, email_ci, password_hash, password_salt, display_name, global_role, disabled_at, created_at, updated_at)
         VALUES (?,?,?, '', '', ?, 'user', ?, ?, ?)`,
        id, person.email, person.email.toLowerCase(), person.display_name, now, now, now,
      );
      userByEmail.set(person.email, id);
    }

    const trackMap = new Map<string, string>();
    for (const t of bundle.tracks as Record<string, unknown>[]) {
      const id = newId("trk");
      trackMap.set(t.id as string, id);
      run(`INSERT INTO tracks (id, event_id, name, slug, description, sort_order) VALUES (?,?,?,?,?,?)`,
        id, eventId, t.name, t.slug, t.description ?? "", t.sort_order ?? 0);
    }
    for (const p of bundle.prizes as Record<string, unknown>[]) {
      run(`INSERT INTO prizes (id, event_id, track_id, name, description, amount_text, sort_order) VALUES (?,?,?,?,?,?,?)`,
        newId("prz"), eventId, p.track_id ? trackMap.get(p.track_id as string) ?? null : null,
        p.name, p.description ?? "", p.amount_text ?? "", p.sort_order ?? 0);
    }
    const questionMap = new Map<string, string>();
    for (const q of bundle.questions as Record<string, unknown>[]) {
      const id = newId("qst");
      questionMap.set(q.id as string, id);
      run(`INSERT INTO custom_questions (id, event_id, prompt, help_text, kind, required, options_json, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
        id, eventId, q.prompt, q.help_text ?? "", q.kind ?? "short_text", q.required ?? 0, q.options_json ?? "[]", q.sort_order ?? 0);
    }
    for (const r of bundle.roles) {
      const uid = userByEmail.get(r.email);
      if (!uid) continue;
      run(`INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, track_id, granted_by, created_at) VALUES (?,?,?,?,?,?,?)`,
        newId("rol"), eventId, uid, r.role, r.track_id ? trackMap.get(r.track_id) ?? null : null, actor.id, now);
    }

    const teamMap = new Map<string, string>();
    for (const t of bundle.teams) {
      const id = newId("tem");
      teamMap.set(t.id, id);
      run(`INSERT INTO teams (id, event_id, name, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, eventId, t.name, actor.id, now);
      for (const m of t.members) {
        const uid = userByEmail.get(m.email);
        if (uid) run(`INSERT OR IGNORE INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?,?,?,?,?)`,
          newId("tmm"), id, uid, m.role, now);
      }
    }

    const projectMap = new Map<string, string>();
    for (const p of bundle.projects as Record<string, unknown>[]) {
      const id = newId("prj");
      projectMap.set(p.id as string, id);
      run(
        `INSERT INTO projects (id, event_id, team_id, track_id, name, tagline, description,
           demo_video_url, repo_url, live_url, status, submitted_at, withdrawn_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, eventId, teamMap.get(p.team_id as string)!, p.track_id ? trackMap.get(p.track_id as string) ?? null : null,
        p.name ?? "", p.tagline ?? "", p.description ?? "", p.demo_video_url ?? "", p.repo_url ?? "", p.live_url ?? "",
        p.status ?? "draft", p.submitted_at ?? null, p.withdrawn_at ?? null, now, now,
      );
    }
    for (const t of bundle.tags) {
      const pid = projectMap.get(t.project_id);
      if (pid) run(`INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?,?)`, pid, t.tag);
    }
    for (const a of bundle.answers as Record<string, unknown>[]) {
      const pid = projectMap.get(a.project_id as string);
      const qid = questionMap.get(a.question_id as string);
      if (pid && qid) run(`INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at) VALUES (?,?,?,?,?)`,
        newId("ans"), pid, qid, a.value_text ?? "", now);
    }

    const rubricMap = new Map<string, string>();
    const criterionMap = new Map<string, string>();
    const weightsByRubric = new Map<string, CriterionWeight[]>();
    for (const r of bundle.rubrics) {
      const rv = r.rubric as Record<string, unknown>;
      const id = newId("rub");
      rubricMap.set(rv.id as string, id);
      run(`INSERT INTO rubric_versions (id, event_id, version, name, status, created_by, created_at, published_at) VALUES (?,?,?,?,?,?,?,?)`,
        id, eventId, rv.version ?? 1, rv.name ?? "Rubric", rv.status ?? "draft", actor.id, now, rv.published_at ?? null);
      for (const c of r.criteria as Record<string, unknown>[]) {
        const cid = newId("crt");
        criterionMap.set(c.id as string, cid);
        const weights = weightsByRubric.get(rv.id as string) ?? [];
        weights.push({ criterionId: c.id as string, weight: (c.weight ?? 1) as number,
          scaleMin: (c.scale_min ?? 1) as number, scaleMax: (c.scale_max ?? 5) as number });
        weightsByRubric.set(rv.id as string, weights);
        run(`INSERT INTO criteria (id, rubric_version_id, name, description, weight, scale_min, scale_max, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
          cid, id, c.name, c.description ?? "", c.weight ?? 1, c.scale_min ?? 1, c.scale_max ?? 5, c.sort_order ?? 0);
      }
    }

    const assignmentMap = new Map<string, string>();
    for (const a of bundle.assignments) {
      const uid = userByEmail.get(a.judge_email);
      const pid = projectMap.get(a.project_id);
      if (!uid || !pid) continue;
      const id = newId("asg");
      assignmentMap.set(a.id, id);
      run(`INSERT OR IGNORE INTO assignments (id, event_id, project_id, judge_user_id, status, batch_label, assigned_by, assigned_at) VALUES (?,?,?,?,?,?,?,?)`,
        id, eventId, pid, uid, a.status, a.batch_label ?? "imported", actor.id, now);
    }
    for (const rv of bundle.reviews) {
      const aid = assignmentMap.get(rv.assignment_id);
      const rub = rubricMap.get(rv.rubric_version_id);
      if (!aid || !rub) continue;
      const id = newId("rvw");
      // Recompute from the criterion scores, exactly as a judge's save does,
      // rather than trusting the weighted figures written in the file.
      const weights = weightsByRubric.get(rv.rubric_version_id) ?? [];
      const entries = rv.scores.map((s) => ({ criterionId: s.criterion_id, score: s.score }));
      const submitted = rv.status === "submitted";
      run(
        `INSERT INTO reviews (id, assignment_id, rubric_version_id, status, overall_comment,
           raw_weighted, raw_weighted_100, complete, created_at, updated_at, submitted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, aid, rub, rv.status, rv.overall_comment ?? "",
        submitted ? weightedScore(entries, weights) : null,
        submitted ? weightedScore100(entries, weights) : null,
        isComplete(entries, weights) ? 1 : 0, now, now, rv.submitted_at,
      );
      for (const s of rv.scores) {
        const cid = criterionMap.get(s.criterion_id);
        if (cid) run(`INSERT INTO criterion_scores (id, review_id, criterion_id, score, comment) VALUES (?,?,?,?,?)`,
          newId("csc"), id, cid, s.score, s.comment ?? "");
      }
    }

    audit.record({
      actor, eventId, action: "bundle.import", subjectType: "event", subjectId: eventId,
      detail: counts,
    });
    return slug;
  });

  return { ok: true, dryRun: false, problems: [], counts, eventSlug: slug };
}
