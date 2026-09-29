import { all, get, run, tx, nowIso } from "../db/client.ts";
import { newId, slugify } from "../ids.ts";
import { requireOrganizer, AccessDenied, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";
import * as webhooks from "./webhooks.ts";

export type EventStatus =
  | "draft" | "open" | "submissions_closed" | "judging" | "results_published" | "archived";

export type EventRow = {
  id: string; slug: string; name: string; tagline: string; description: string;
  timezone: string; status: EventStatus;
  submissions_open_at: string | null; submissions_close_at: string | null;
  judging_open_at: string | null; judging_close_at: string | null;
  results_published_at: string | null;
  reviews_per_project: number; max_team_size: number;
  voting_enabled: number; voting_mode: "open_link" | "email_gated" | "authenticated";
  voting_open_at: string | null; voting_close_at: string | null;
  votes_per_voter: number; voting_results_public: number;
  comments_enabled: number;
  created_by: string; created_at: string; updated_at: string; version: number;
};

export type TrackRow = { id: string; event_id: string; name: string; slug: string; description: string; sort_order: number };
export type PrizeRow = { id: string; event_id: string; track_id: string | null; name: string; description: string; amount_text: string; sort_order: number };
export type QuestionRow = {
  id: string; event_id: string; prompt: string; help_text: string; kind: string;
  required: number; options_json: string; is_public: number; sort_order: number;
};

/**
 * Legal transitions. Anything not listed here is refused, so an event cannot
 * skip from draft straight to published results.
 */
const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft:              ["open", "archived"],
  open:               ["submissions_closed", "archived"],
  submissions_closed: ["judging", "open", "archived"],
  judging:            ["results_published", "submissions_closed", "archived"],
  results_published:  ["judging", "archived"],
  archived:           [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function bySlug(slug: string): EventRow | undefined {
  return get<EventRow>(`SELECT * FROM events WHERE slug = ?`, slug);
}

export function byId(id: string): EventRow | undefined {
  return get<EventRow>(`SELECT * FROM events WHERE id = ?`, id);
}

/** Events a visitor may see. Drafts are never public. */
export function listPublic(): EventRow[] {
  return all<EventRow>(
    `SELECT * FROM events WHERE status != 'draft' ORDER BY created_at DESC`,
  );
}

export function listForActor(actor: Actor): EventRow[] {
  if (actor.globalRole === "admin") return all<EventRow>(`SELECT * FROM events ORDER BY created_at DESC`);
  return all<EventRow>(
    `SELECT DISTINCT e.* FROM events e
       LEFT JOIN event_roles r ON r.event_id = e.id AND r.user_id = ?
      WHERE e.status != 'draft' OR r.id IS NOT NULL
      ORDER BY e.created_at DESC`,
    actor.id,
  );
}

export function tracks(eventId: string): TrackRow[] {
  return all<TrackRow>(`SELECT * FROM tracks WHERE event_id = ? ORDER BY sort_order, name`, eventId);
}
export function prizes(eventId: string): PrizeRow[] {
  return all<PrizeRow>(`SELECT * FROM prizes WHERE event_id = ? ORDER BY sort_order, name`, eventId);
}
export function questions(eventId: string): QuestionRow[] {
  return all<QuestionRow>(`SELECT * FROM custom_questions WHERE event_id = ? ORDER BY sort_order`, eventId);
}

export function createEvent(actor: Actor, input: {
  name: string; tagline?: string; description?: string; timezone?: string;
}): EventRow {
  const id = newId("evt");
  const now = nowIso();
  let slug = slugify(input.name, "event");
  // Slug collision: append a discriminator rather than failing the create.
  if (bySlug(slug)) slug = `${slug}-${id.slice(-4)}`;
  run(
    `INSERT INTO events (id, slug, name, tagline, description, timezone, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'draft', ?,?,?)`,
    id, slug, input.name.trim(), input.tagline?.trim() ?? "", input.description?.trim() ?? "",
    input.timezone ?? "UTC", actor.id, now, now,
  );
  run(
    `INSERT INTO event_roles (id, event_id, user_id, role, granted_by, created_at) VALUES (?,?,?, 'organizer', ?,?)`,
    newId("rol"), id, actor.id, actor.id, now,
  );
  audit.record({ actor, eventId: id, action: "event.create", subjectType: "event", subjectId: id, detail: { name: input.name } });
  return byId(id)!;
}

/**
 * Window ordering. Each window must close after it opens, and judging cannot
 * finish before submissions do — an event whose judging window closed while
 * people were still submitting would be unjudgeable. Checked here rather than
 * in a form so the API and any import obey the same rule.
 */
export function windowProblems(e: Pick<EventRow,
  "submissions_open_at" | "submissions_close_at" | "judging_open_at" | "judging_close_at" | "voting_open_at" | "voting_close_at">): string[] {
  const t = (v: string | null) => (v ? Date.parse(v) : null);
  const problems: string[] = [];
  const pairs: [string, number | null, number | null][] = [
    ["Submissions", t(e.submissions_open_at), t(e.submissions_close_at)],
    ["Judging", t(e.judging_open_at), t(e.judging_close_at)],
    ["Voting", t(e.voting_open_at), t(e.voting_close_at)],
  ];
  for (const [label, open, close] of pairs) {
    if (open !== null && close !== null && close <= open) {
      problems.push(`${label} must close after it opens.`);
    }
  }
  const subClose = t(e.submissions_close_at);
  const judgeClose = t(e.judging_close_at);
  if (subClose !== null && judgeClose !== null && judgeClose < subClose) {
    problems.push("Judging cannot close before submissions close.");
  }
  return problems;
}

export function updateEvent(cap: Capability, patch: Partial<{
  name: string; tagline: string; description: string; timezone: string;
  submissions_open_at: string | null; submissions_close_at: string | null;
  judging_open_at: string | null; judging_close_at: string | null;
  reviews_per_project: number; max_team_size: number;
  voting_enabled: number; voting_mode: string;
  voting_open_at: string | null; voting_close_at: string | null;
  votes_per_voter: number; voting_results_public: number; comments_enabled: number;
}>, expectedVersion?: number): EventRow {
  requireOrganizer(cap);
  const current = byId(cap.eventId);
  if (!current) throw new AccessDenied("event not found");
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw new Error("This event was changed by someone else. Reload and try again.");
  }
  const problems = windowProblems({ ...current, ...patch } as EventRow);
  if (problems.length) throw new Error(problems.join(" "));

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return current;
  run(
    `UPDATE events SET ${fields.join(", ")}, updated_at = ?, version = version + 1 WHERE id = ?`,
    ...values, nowIso(), cap.eventId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "event.update", subjectType: "event", subjectId: cap.eventId, detail: patch as Record<string, unknown> });
  return byId(cap.eventId)!;
}

export function setStatus(cap: Capability, to: EventStatus): EventRow {
  requireOrganizer(cap);
  const current = byId(cap.eventId);
  if (!current) throw new AccessDenied("event not found");
  if (current.status === to) return current;
  if (!canTransition(current.status, to)) {
    throw new Error(`Cannot move an event from ${current.status} to ${to}.`);
  }
  const now = nowIso();
  run(
    `UPDATE events SET status = ?, updated_at = ?, version = version + 1,
       results_published_at = CASE WHEN ? = 'results_published' THEN ? ELSE results_published_at END
     WHERE id = ?`,
    to, now, to, now, cap.eventId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "event.status", subjectType: "event", subjectId: cap.eventId, detail: { from: current.status, to } });
  webhooks.emit(cap.eventId, "event.status_changed", { from: current.status, to });
  return byId(cap.eventId)!;
}

export function addTrack(cap: Capability, name: string, description = ""): TrackRow {
  requireOrganizer(cap);
  const id = newId("trk");
  run(
    `INSERT INTO tracks (id, event_id, name, slug, description, sort_order)
     VALUES (?,?,?,?,?, (SELECT IFNULL(MAX(sort_order),0)+1 FROM tracks WHERE event_id = ?))`,
    id, cap.eventId, name.trim(), slugify(name, id.slice(-6)), description, cap.eventId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "track.create", subjectType: "track", subjectId: id, detail: { name } });
  return get<TrackRow>(`SELECT * FROM tracks WHERE id = ?`, id)!;
}

export function addPrize(cap: Capability, input: { name: string; amountText?: string; description?: string; trackId?: string | null }): PrizeRow {
  requireOrganizer(cap);
  const id = newId("prz");
  run(
    `INSERT INTO prizes (id, event_id, track_id, name, description, amount_text, sort_order)
     VALUES (?,?,?,?,?,?, (SELECT IFNULL(MAX(sort_order),0)+1 FROM prizes WHERE event_id = ?))`,
    id, cap.eventId, input.trackId ?? null, input.name.trim(), input.description ?? "", input.amountText ?? "", cap.eventId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "prize.create", subjectType: "prize", subjectId: id, detail: { name: input.name } });
  return get<PrizeRow>(`SELECT * FROM prizes WHERE id = ?`, id)!;
}

export const QUESTION_KINDS = ["short_text", "long_text", "url", "single_select", "multi_select"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export function questionOptions(q: QuestionRow): string[] {
  try {
    const parsed: unknown = JSON.parse(q.options_json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

export function addQuestion(cap: Capability, input: {
  prompt: string; kind?: string; required?: boolean; helpText?: string;
  options?: string[]; isPublic?: boolean;
}): QuestionRow {
  requireOrganizer(cap);
  const prompt = input.prompt.trim();
  if (prompt.length < 2) throw new Error("Give the question a prompt.");
  const kind = (input.kind ?? "short_text") as QuestionKind;
  if (!QUESTION_KINDS.includes(kind)) throw new Error("Unknown question type.");

  const options = [...new Set((input.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, 30);
  if (kind === "single_select" || kind === "multi_select") {
    if (options.length < 2) throw new Error("A choice question needs at least two options.");
  }

  const id = newId("qst");
  run(
    `INSERT INTO custom_questions (id, event_id, prompt, help_text, kind, required, options_json, is_public, sort_order)
     VALUES (?,?,?,?,?,?,?,?, (SELECT IFNULL(MAX(sort_order),0)+1 FROM custom_questions WHERE event_id = ?))`,
    id, cap.eventId, prompt, input.helpText?.trim() ?? "", kind,
    input.required ? 1 : 0, JSON.stringify(options), input.isPublic ? 1 : 0, cap.eventId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "question.create", subjectType: "question", subjectId: id, detail: { prompt, kind, required: !!input.required, public: !!input.isPublic } });
  return get<QuestionRow>(`SELECT * FROM custom_questions WHERE id = ?`, id)!;
}

/**
 * Removal is refused once the question, track or prize is referenced by work
 * that has already been submitted: deleting it would silently rewrite what a
 * team sent in. The organizer is told which one is in the way.
 */
export function removeQuestion(cap: Capability, questionId: string) {
  requireOrganizer(cap);
  const q = get<QuestionRow>(`SELECT * FROM custom_questions WHERE id = ? AND event_id = ?`, questionId, cap.eventId);
  if (!q) throw new AccessDenied("question not found in this event");
  const answered = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM custom_answers WHERE question_id = ? AND TRIM(value_text) != ''`, questionId)!.n;
  if (answered > 0) throw new Error(`${answered} team(s) have already answered this question, so it cannot be removed.`);
  run(`DELETE FROM custom_questions WHERE id = ?`, questionId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "question.remove", subjectType: "question", subjectId: questionId, detail: { prompt: q.prompt } });
}

export function removeTrack(cap: Capability, trackId: string) {
  requireOrganizer(cap);
  const t = get<TrackRow>(`SELECT * FROM tracks WHERE id = ? AND event_id = ?`, trackId, cap.eventId);
  if (!t) throw new AccessDenied("track not found in this event");
  const used = get<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE track_id = ?`, trackId)!.n;
  if (used > 0) throw new Error(`${used} project(s) are in this track. Move them first.`);
  const grants = get<{ n: number }>(`SELECT COUNT(*) AS n FROM event_roles WHERE track_id = ?`, trackId)!.n;
  if (grants > 0) throw new Error(`${grants} judge grant(s) are restricted to this track. Change them first.`);
  run(`DELETE FROM tracks WHERE id = ?`, trackId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "track.remove", subjectType: "track", subjectId: trackId, detail: { name: t.name } });
}

export function removePrize(cap: Capability, prizeId: string) {
  requireOrganizer(cap);
  const p = get<PrizeRow>(`SELECT * FROM prizes WHERE id = ? AND event_id = ?`, prizeId, cap.eventId);
  if (!p) throw new AccessDenied("prize not found in this event");
  run(`DELETE FROM prizes WHERE id = ?`, prizeId);
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "prize.remove", subjectType: "prize", subjectId: prizeId, detail: { name: p.name } });
}

/** Server-side clock is the only clock that counts. */
export function submissionsOpen(e: EventRow, at: Date = new Date()): boolean {
  if (e.status !== "open") return false;
  const t = at.getTime();
  if (e.submissions_open_at && t < Date.parse(e.submissions_open_at)) return false;
  if (e.submissions_close_at && t > Date.parse(e.submissions_close_at)) return false;
  return true;
}

export function judgingOpen(e: EventRow, at: Date = new Date()): boolean {
  if (e.status !== "judging") return false;
  const t = at.getTime();
  if (e.judging_open_at && t < Date.parse(e.judging_open_at)) return false;
  if (e.judging_close_at && t > Date.parse(e.judging_close_at)) return false;
  return true;
}

export function grantRole(cap: Capability, userId: string, role: "participant" | "judge" | "organizer", trackId: string | null = null) {
  requireOrganizer(cap);
  run(
    `INSERT OR IGNORE INTO event_roles (id, event_id, user_id, role, track_id, granted_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId("rol"), cap.eventId, userId, role, trackId, cap.actor?.id ?? null, nowIso(),
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "role.grant", subjectType: "user", subjectId: userId, detail: { role, trackId } });
}

export function revokeRole(cap: Capability, userId: string, role: string, trackId: string | null = null) {
  requireOrganizer(cap);
  run(
    `DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = ? AND IFNULL(track_id,'') = IFNULL(?,'')`,
    cap.eventId, userId, role, trackId,
  );
  audit.record({ actor: cap.actor, eventId: cap.eventId, action: "role.revoke", subjectType: "user", subjectId: userId, detail: { role, trackId } });
}

export type ChecklistItem = { label: string; done: boolean; detail: string; href: string };

/**
 * The setup checklist, read from what is actually stored. Nothing here is a
 * stored "progress" field that could drift from reality: each line is a count
 * taken when the page renders.
 */
export function setupChecklist(cap: Capability, slug: string): ChecklistItem[] {
  requireOrganizer(cap);
  const e = byId(cap.eventId)!;
  const n = (sql: string, ...params: unknown[]) => get<{ n: number }>(sql, ...params)!.n;
  const setup = `/events/${slug}/organize/setup`;

  const trackCount = n(`SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?`, e.id);
  const prizeCount = n(`SELECT COUNT(*) AS n FROM prizes WHERE event_id = ?`, e.id);
  const questionCount = n(`SELECT COUNT(*) AS n FROM custom_questions WHERE event_id = ?`, e.id);
  const judgeCount = n(`SELECT COUNT(DISTINCT user_id) AS n FROM event_roles WHERE event_id = ? AND role = 'judge'`, e.id);
  const rubric = get<{ version: number; criteria: number }>(
    `SELECT rv.version, (SELECT COUNT(*) FROM criteria c WHERE c.rubric_version_id = rv.id) AS criteria
       FROM rubric_versions rv WHERE rv.event_id = ? AND rv.status = 'published'
      ORDER BY rv.version DESC LIMIT 1`, e.id);
  const submitted = n(`SELECT COUNT(*) AS n FROM projects WHERE event_id = ? AND status = 'submitted'`, e.id);
  const assignments = n(`SELECT COUNT(*) AS n FROM assignments WHERE event_id = ? AND status != 'revoked'`, e.id);

  return [
    {
      label: "Describe the event",
      done: e.tagline.trim().length > 0 && e.description.trim().length > 0,
      detail: e.tagline.trim() && e.description.trim() ? "Tagline and description are set." : "A tagline and description appear on the public page.",
      href: setup,
    },
    {
      label: "Set the submission window",
      done: !!e.submissions_open_at && !!e.submissions_close_at,
      detail: e.submissions_close_at ? `Closes ${e.submissions_close_at.slice(0, 16).replace("T", " ")} UTC.` : "The deadline is enforced on the server.",
      href: setup,
    },
    {
      label: "Add tracks",
      done: trackCount > 0,
      detail: trackCount ? `${trackCount} track(s).` : "Optional, but judges can be restricted to a track.",
      href: setup,
    },
    {
      label: "Add prizes",
      done: prizeCount > 0,
      detail: prizeCount ? `${prizeCount} prize(s) listed publicly.` : "Shown on the event page. Optional.",
      href: setup,
    },
    {
      label: "Ask your own questions",
      done: questionCount > 0,
      detail: questionCount ? `${questionCount} question(s) on the submission form.` : "Optional extra fields for every submission.",
      href: setup,
    },
    {
      label: "Publish a rubric",
      done: !!rubric,
      detail: rubric ? `Version ${rubric.version}, ${rubric.criteria} criteria.` : "Judging cannot start without one.",
      href: `/events/${slug}/organize/rubric`,
    },
    {
      label: "Invite judges",
      done: judgeCount > 0,
      detail: judgeCount ? `${judgeCount} judge(s) on the panel.` : "Send a scoped invitation link.",
      href: `/events/${slug}/organize/panel`,
    },
    {
      label: "Assign reviews",
      done: assignments > 0,
      detail: assignments ? `${assignments} assignment(s) across ${submitted} submitted project(s).` : "Generate them once projects are in.",
      href: `/events/${slug}/organize/assignments`,
    },
  ];
}

export type PanelMember = { user_id: string; display_name: string; email: string; role: string; track_id: string | null; track_name: string | null };

export function panel(cap: Capability): PanelMember[] {
  requireOrganizer(cap);
  return all<PanelMember>(
    `SELECT r.user_id, u.display_name, u.email, r.role, r.track_id, t.name AS track_name
       FROM event_roles r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN tracks t ON t.id = r.track_id
      WHERE r.event_id = ?
      ORDER BY r.role, u.display_name`,
    cap.eventId,
  );
}
