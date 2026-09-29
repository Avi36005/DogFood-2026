import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, isProjectOwner, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";
import { byId as eventById, submissionsOpen, type EventRow } from "./events.ts";

export type ProjectStatus = "draft" | "submitted" | "withdrawn";

export type ProjectRow = {
  id: string; event_id: string; team_id: string; track_id: string | null;
  name: string; tagline: string; description: string;
  thumbnail_asset_id: string | null;
  demo_video_url: string; repo_url: string; live_url: string;
  status: ProjectStatus; submitted_at: string | null; withdrawn_at: string | null;
  disqualified_at: string | null;
  created_at: string; updated_at: string; version: number;
};

export type GalleryItem = ProjectRow & {
  team_name: string; track_name: string | null; tags: string;
};

const URL_FIELDS = ["demo_video_url", "repo_url", "live_url"] as const;

function validUrlOrEmpty(value: string, label: string): string {
  const v = value.trim();
  if (!v) return "";
  let parsed: URL;
  try { parsed = new URL(v); } catch { throw new Error(`${label} must be a full URL starting with http:// or https://`); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
  return parsed.toString();
}

export function forTeam(teamId: string): ProjectRow | undefined {
  return get<ProjectRow>(`SELECT * FROM projects WHERE team_id = ?`, teamId);
}

export function byId(id: string): ProjectRow | undefined {
  return get<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, id);
}

export function tagsFor(projectId: string): string[] {
  return all<{ tag: string }>(`SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag`, projectId).map((r) => r.tag);
}

export function answersFor(projectId: string): Record<string, string> {
  const rows = all<{ question_id: string; value_text: string }>(
    `SELECT question_id, value_text FROM custom_answers WHERE project_id = ?`, projectId);
  return Object.fromEntries(rows.map((r) => [r.question_id, r.value_text]));
}

export function ensureDraft(cap: Capability, actor: Actor, teamId: string): ProjectRow {
  const existing = forTeam(teamId);
  if (existing) return existing;
  const id = newId("prj");
  const now = nowIso();
  run(
    `INSERT INTO projects (id, event_id, team_id, created_at, updated_at) VALUES (?,?,?,?,?)`,
    id, cap.eventId, teamId, now, now,
  );
  audit.record({ actor, eventId: cap.eventId, action: "project.create", subjectType: "project", subjectId: id });
  return byId(id)!;
}

/**
 * Deadline enforcement lives here, on the server, using the server clock.
 * The UI also hides the form after the deadline, but that is a courtesy: this
 * check is the one that decides.
 */
function assertEditable(event: EventRow, project: ProjectRow, cap: Capability) {
  if (cap.isOrganizer) return; // organizers may correct a record, and it is audited
  if (project.status === "withdrawn") throw new Error("This project has been withdrawn.");
  if (!submissionsOpen(event)) {
    throw new Error("The submission window for this event is closed.");
  }
}

export function saveDraft(
  cap: Capability, actor: Actor, projectId: string,
  patch: Partial<Pick<ProjectRow, "name" | "tagline" | "description" | "track_id" | "demo_video_url" | "repo_url" | "live_url" | "thumbnail_asset_id">>,
  tags?: string[],
  answers?: Record<string, string>,
  expectedVersion?: number,
): ProjectRow {
  const project = byId(projectId);
  if (!project) throw new Error("Project not found.");
  if (project.event_id !== cap.eventId) throw new AccessDenied("project belongs to another event");
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  const event = eventById(cap.eventId)!;
  assertEditable(event, project, cap);

  if (expectedVersion !== undefined && expectedVersion !== project.version) {
    throw new Error("A teammate saved this project while you were editing. Reload to see their changes.");
  }

  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n.length > 120) throw new Error("Project name must be 120 characters or fewer.");
    clean.name = n;
  }
  if (patch.tagline !== undefined) {
    const t = patch.tagline.trim();
    if (t.length > 200) throw new Error("Tagline must be 200 characters or fewer.");
    clean.tagline = t;
  }
  if (patch.description !== undefined) {
    if (patch.description.length > 20000) throw new Error("Description must be 20,000 characters or fewer.");
    clean.description = patch.description;
  }
  if (patch.track_id !== undefined) {
    if (patch.track_id) {
      const ok = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE id = ? AND event_id = ?`, patch.track_id, cap.eventId)!.n;
      if (!ok) throw new Error("That track does not belong to this event.");
    }
    clean.track_id = patch.track_id || null;
  }
  for (const f of URL_FIELDS) {
    if (patch[f] !== undefined) {
      const label = f === "demo_video_url" ? "Demo video URL" : f === "repo_url" ? "Repository URL" : "Live URL";
      clean[f] = validUrlOrEmpty(patch[f] as string, label);
    }
  }
  if (patch.thumbnail_asset_id !== undefined) clean.thumbnail_asset_id = patch.thumbnail_asset_id || null;

  return tx(() => {
    if (Object.keys(clean).length) {
      const sets = Object.keys(clean).map((k) => `${k} = ?`).join(", ");
      run(`UPDATE projects SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ?`,
        ...Object.values(clean), nowIso(), projectId);
    }
    if (tags) {
      const cleaned = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
      run(`DELETE FROM project_tags WHERE project_id = ?`, projectId);
      for (const tag of cleaned) {
        if (tag.length <= 40) run(`INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?,?)`, projectId, tag);
      }
    }
    if (answers) {
      for (const [questionId, value] of Object.entries(answers)) {
        const q = get<{ id: string; prompt: string; kind: string; options_json: string }>(
          `SELECT id, prompt, kind, options_json FROM custom_questions WHERE id = ? AND event_id = ?`,
          questionId, cap.eventId);
        // A question id from another event, or one that no longer exists, is
        // ignored rather than trusted.
        if (!q) continue;
        checkAnswer(q, value);
        run(
          `INSERT INTO custom_answers (id, project_id, question_id, value_text, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(project_id, question_id) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at`,
          newId("ans"), projectId, questionId, value.slice(0, 5000), nowIso(),
        );
      }
    }
    return byId(projectId)!;
  });
}

/**
 * Choice answers are checked against the options the organizer configured, so
 * a hand-written request cannot store a value that was never on offer. Several
 * choices arrive as one value per line.
 */
function checkAnswer(q: { prompt: string; kind: string; options_json: string }, value: string) {
  if (q.kind !== "single_select" && q.kind !== "multi_select") return;
  let options: string[] = [];
  try { const parsed: unknown = JSON.parse(q.options_json); if (Array.isArray(parsed)) options = parsed.map(String); }
  catch { options = []; }
  const chosen = value.split("\n").map((v) => v.trim()).filter(Boolean);
  if (chosen.length === 0) return;
  if (q.kind === "single_select" && chosen.length > 1) {
    throw new Error(`"${q.prompt}" takes a single answer.`);
  }
  for (const c of chosen) {
    if (!options.includes(c)) throw new Error(`"${c}" is not one of the options for "${q.prompt}".`);
  }
}

export type SubmitProblem = { field: string; message: string };

/** Requiredness is organizer-configurable; these are the fields the platform itself insists on. */
export function validateForSubmit(projectId: string, eventId: string): SubmitProblem[] {
  const p = byId(projectId)!;
  const problems: SubmitProblem[] = [];
  if (!p.name.trim()) problems.push({ field: "name", message: "A project name is required." });
  if (!p.tagline.trim()) problems.push({ field: "tagline", message: "A tagline is required." });
  if (!p.description.trim()) problems.push({ field: "description", message: "A description is required." });
  const trackCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?`, eventId)!.n;
  if (trackCount > 0 && !p.track_id) problems.push({ field: "track_id", message: "Choose a track." });

  const required = all<{ id: string; prompt: string }>(
    `SELECT id, prompt FROM custom_questions WHERE event_id = ? AND required = 1`, eventId);
  const answers = answersFor(projectId);
  for (const q of required) {
    if (!(answers[q.id] ?? "").trim()) problems.push({ field: `q:${q.id}`, message: `"${q.prompt}" is required.` });
  }
  return problems;
}

export function submit(cap: Capability, actor: Actor, projectId: string): ProjectRow {
  const project = byId(projectId);
  if (!project) throw new Error("Project not found.");
  if (project.event_id !== cap.eventId) throw new AccessDenied("project belongs to another event");
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  const event = eventById(cap.eventId)!;
  assertEditable(event, project, cap);

  const problems = validateForSubmit(projectId, cap.eventId);
  if (problems.length) {
    const err = new Error(problems.map((p) => p.message).join(" "));
    (err as Error & { problems?: SubmitProblem[] }).problems = problems;
    throw err;
  }

  return tx(() => {
    const now = nowIso();
    run(
      `UPDATE projects SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), updated_at = ?, version = version + 1
        WHERE id = ?`,
      now, now, projectId,
    );
    snapshot(projectId, actor, "submit");
    audit.record({ actor, eventId: cap.eventId, action: "project.submit", subjectType: "project", subjectId: projectId });
    webhooks.emit(cap.eventId, "project.submitted", { project_id: projectId, name: project.name });
    return byId(projectId)!;
  });
}

export function withdraw(cap: Capability, actor: Actor, projectId: string): ProjectRow {
  const project = byId(projectId);
  if (!project) throw new Error("Project not found.");
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  run(`UPDATE projects SET status = 'withdrawn', withdrawn_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    nowIso(), nowIso(), projectId);
  snapshot(projectId, actor, "withdraw");
  audit.record({ actor, eventId: project.event_id, action: "project.withdraw", subjectType: "project", subjectId: projectId });
  webhooks.emit(project.event_id, "project.withdrawn", { project_id: projectId });
  return byId(projectId)!;
}

export type EligibilityDecision = {
  id: string; project_id: string; decision: "disqualified" | "reinstated";
  reason: string; decided_by: string; decided_at: string; decided_by_name?: string;
};

/**
 * An organizer's eligibility decision. Disqualifying does not touch the team's
 * submission: the content stays exactly as it was, the decision is appended
 * with its reason, and every eligible-project query filters on the flag. A
 * disqualified project leaves the gallery, the assignment pool and the score
 * calculation — it never silently stays in the running.
 */
export function setEligibility(
  cap: Capability, projectId: string, decision: "disqualified" | "reinstated", reason: string,
): ProjectRow {
  if (!cap.isOrganizer) throw new AccessDenied("organizer role required");
  const project = byId(projectId);
  if (!project) throw new Error("Project not found.");
  if (project.event_id !== cap.eventId) throw new AccessDenied("project belongs to another event");
  const why = reason.trim();
  if (why.length < 4) throw new Error("Record a reason for this decision.");

  return tx(() => {
    const now = nowIso();
    run(
      `UPDATE projects SET disqualified_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      decision === "disqualified" ? now : null, now, projectId,
    );
    run(
      `INSERT INTO eligibility_decisions (id, event_id, project_id, decision, reason, decided_by, decided_at)
       VALUES (?,?,?,?,?,?,?)`,
      newId("elg"), cap.eventId, projectId, decision, why, cap.actor!.id, now,
    );
    audit.record({
      actor: cap.actor, eventId: cap.eventId, action: `project.${decision}`,
      subjectType: "project", subjectId: projectId, detail: { reason: why },
    });
    webhooks.emit(cap.eventId, "project.eligibility_changed", { project_id: projectId, decision });
    return byId(projectId)!;
  });
}

export function eligibilityHistory(projectId: string): EligibilityDecision[] {
  return all<EligibilityDecision>(
    `SELECT d.*, u.display_name AS decided_by_name
       FROM eligibility_decisions d JOIN users u ON u.id = d.decided_by
      WHERE d.project_id = ? ORDER BY d.decided_at DESC`,
    projectId,
  );
}

/** Append-only record of what the submission looked like at a moment. */
export function snapshot(projectId: string, actor: Actor, reason: string) {
  const p = byId(projectId)!;
  const payload = { ...p, tags: tagsFor(projectId), answers: answersFor(projectId) };
  const next = (get<{ n: number }>(`SELECT IFNULL(MAX(revision),0) AS n FROM submission_revisions WHERE project_id = ?`, projectId)!.n) + 1;
  run(
    `INSERT INTO submission_revisions (id, project_id, revision, snapshot_json, reason, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId("rev"), projectId, next, JSON.stringify(payload), reason, actor.id, nowIso(),
  );
}

export function revisions(projectId: string) {
  return all<{ id: string; revision: number; reason: string; created_at: string; created_by: string }>(
    `SELECT id, revision, reason, created_at, created_by FROM submission_revisions
      WHERE project_id = ? ORDER BY revision DESC`, projectId);
}

/**
 * The SQL for "still in the running": submitted, not withdrawn, not
 * disqualified. Every gallery, assignment, ballot and scoring query uses this
 * same phrase, so an eligibility decision cannot apply in one place and be
 * forgotten in another.
 */
export const ELIGIBLE = `status = 'submitted' AND disqualified_at IS NULL`;

/**
 * Public gallery. Only eligible projects are ever returned, and only for events
 * that have left draft. Search covers name, tagline, description and tags.
 */
export function gallery(eventId: string, opts: { q?: string; trackId?: string; tag?: string; limit?: number; offset?: number } = {}): GalleryItem[] {
  const where: string[] = [`p.event_id = ?`, `p.status = 'submitted'`, `p.disqualified_at IS NULL`];
  const params: unknown[] = [eventId];
  if (opts.trackId) { where.push(`p.track_id = ?`); params.push(opts.trackId); }
  if (opts.tag) { where.push(`EXISTS (SELECT 1 FROM project_tags pt WHERE pt.project_id = p.id AND pt.tag = ?)`); params.push(opts.tag.toLowerCase()); }
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().toLowerCase()}%`;
    where.push(`(lower(p.name) LIKE ? OR lower(p.tagline) LIKE ? OR lower(p.description) LIKE ?
                 OR EXISTS (SELECT 1 FROM project_tags pt WHERE pt.project_id = p.id AND pt.tag LIKE ?))`);
    params.push(like, like, like, like);
  }
  params.push(opts.limit ?? 60, opts.offset ?? 0);
  return all<GalleryItem>(
    `SELECT p.*, t.name AS team_name, tr.name AS track_name,
            IFNULL((SELECT GROUP_CONCAT(tag, ',') FROM project_tags pt WHERE pt.project_id = p.id), '') AS tags
       FROM projects p
       JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = p.track_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.submitted_at DESC, p.name
      LIMIT ? OFFSET ?`,
    ...params,
  );
}

export function galleryCount(eventId: string): number {
  return get<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND ${ELIGIBLE}`, eventId)!.n;
}

export function allTags(eventId: string): { tag: string; n: number }[] {
  return all<{ tag: string; n: number }>(
    `SELECT pt.tag, COUNT(*) AS n FROM project_tags pt
       JOIN projects p ON p.id = pt.project_id
      WHERE p.event_id = ? AND p.status = 'submitted' AND p.disqualified_at IS NULL
      GROUP BY pt.tag ORDER BY n DESC, pt.tag LIMIT 40`,
    eventId,
  );
}

/** Organizer view: every project including drafts, with review progress. */
export function listForOrganizer(cap: Capability) {
  if (!cap.isOrganizer) throw new AccessDenied("organizer role required");
  return all<GalleryItem & { assigned: number; reviewed: number }>(
    `SELECT p.*, t.name AS team_name, tr.name AS track_name,
            IFNULL((SELECT GROUP_CONCAT(tag, ',') FROM project_tags pt WHERE pt.project_id = p.id), '') AS tags,
            (SELECT COUNT(*) FROM assignments a WHERE a.project_id = p.id AND a.status != 'revoked') AS assigned,
            (SELECT COUNT(*) FROM assignments a JOIN reviews r ON r.assignment_id = a.id
              WHERE a.project_id = p.id AND r.status = 'submitted') AS reviewed
       FROM projects p
       JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = p.track_id
      WHERE p.event_id = ?
      ORDER BY p.status, p.name`,
    cap.eventId,
  );
}
