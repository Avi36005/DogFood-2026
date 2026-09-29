import { all } from "../db/client.ts";
import { requireOrganizer, type Capability } from "../authz.ts";
import * as audit from "./audit.ts";

/**
 * RFC 4180 CSV. Values are always quoted, so a tagline containing a comma, a
 * quote or a newline round-trips into a spreadsheet without shifting columns.
 * A leading =, +, - or @ is prefixed with a single quote to stop spreadsheets
 * evaluating cell contents as a formula.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return (columns ?? []).map(esc).join(",") + "\r\n";
  const cols = columns ?? Object.keys(rows[0]);
  const lines = [cols.map(esc).join(",")];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

function esc(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export type ExportName =
  | "projects" | "teams" | "judges" | "assignments" | "reviews"
  | "criterion-scores" | "results" | "audit";

/**
 * Column headers per export. Declared rather than inferred from the first row,
 * so an export with no rows still produces a valid, self-describing file
 * instead of an empty one a spreadsheet cannot open.
 */
const COLUMNS: Record<ExportName, string[]> = {
  projects: ["project_id","name","tagline","team","track","status","submitted_at","repo_url","live_url","demo_video_url","tags","created_at","updated_at"],
  teams: ["team_id","team","display_name","email","role","joined_at"],
  judges: ["judge_id","display_name","email","track","assigned","submitted"],
  assignments: ["assignment_id","project","judge","judge_email","status","batch_label","assigned_at","review_status"],
  reviews: ["review_id","project","judge","judge_email","status","weighted_score","submitted_at","overall_comment"],
  "criterion-scores": ["project","judge","criterion","weight","score","scale_min","scale_max","comment","review_status"],
  results: ["rank","project","team","track","normalized_mean","raw_mean","raw_rank","rank_delta","reviews_counted","algorithm","snapshot_status","computed_at"],
  audit: ["created_at","actor_label","action","subject_type","subject_id","outcome","detail_json"],
};

export const EXPORTS: { name: ExportName; label: string; description: string }[] = [
  { name: "projects", label: "Projects", description: "Every project with team, track, tags and submission state." },
  { name: "teams", label: "Teams & members", description: "Team roster with member emails and join dates." },
  { name: "judges", label: "Judges & progress", description: "Panel list with assigned, drafted and submitted counts." },
  { name: "assignments", label: "Assignments", description: "Judge-to-project allocation with batch label and status." },
  { name: "reviews", label: "Reviews", description: "One row per submitted review with its weighted score." },
  { name: "criterion-scores", label: "Criterion scores", description: "Per-criterion detail behind every review." },
  { name: "results", label: "Results", description: "Latest snapshot: raw, normalized, rank and movement." },
  { name: "audit", label: "Audit log", description: "Full operator-readable trail for this event." },
];

export function exportCsv(cap: Capability, name: ExportName): string {
  requireOrganizer(cap);
  const e = cap.eventId;
  let rows: Record<string, unknown>[] = [];

  switch (name) {
    case "projects":
      rows = all(
        `SELECT p.id AS project_id, p.name, p.tagline, t.name AS team, tr.name AS track,
                p.status, p.submitted_at, p.repo_url, p.live_url, p.demo_video_url,
                IFNULL((SELECT GROUP_CONCAT(tag, ' ') FROM project_tags pt WHERE pt.project_id = p.id),'') AS tags,
                p.created_at, p.updated_at
           FROM projects p JOIN teams t ON t.id = p.team_id
           LEFT JOIN tracks tr ON tr.id = p.track_id
          WHERE p.event_id = ? ORDER BY p.name`, e);
      break;
    case "teams":
      rows = all(
        `SELECT t.id AS team_id, t.name AS team, u.display_name, u.email, m.role, m.joined_at
           FROM teams t JOIN team_members m ON m.team_id = t.id JOIN users u ON u.id = m.user_id
          WHERE t.event_id = ? ORDER BY t.name, m.role DESC, u.display_name`, e);
      break;
    case "judges":
      rows = all(
        `SELECT u.id AS judge_id, u.display_name, u.email,
                IFNULL(tr.name,'(all tracks)') AS track,
                (SELECT COUNT(*) FROM assignments a WHERE a.judge_user_id = u.id AND a.event_id = ? AND a.status != 'revoked') AS assigned,
                (SELECT COUNT(*) FROM assignments a JOIN reviews r ON r.assignment_id = a.id
                  WHERE a.judge_user_id = u.id AND a.event_id = ? AND r.status = 'submitted') AS submitted
           FROM event_roles er JOIN users u ON u.id = er.user_id
           LEFT JOIN tracks tr ON tr.id = er.track_id
          WHERE er.event_id = ? AND er.role = 'judge' ORDER BY u.display_name`, e, e, e);
      break;
    case "assignments":
      rows = all(
        `SELECT a.id AS assignment_id, p.name AS project, u.display_name AS judge, u.email AS judge_email,
                a.status, a.batch_label, a.assigned_at, IFNULL(r.status,'none') AS review_status
           FROM assignments a JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.judge_user_id
           LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE a.event_id = ? ORDER BY p.name, u.display_name`, e);
      break;
    case "reviews":
      rows = all(
        `SELECT r.id AS review_id, p.name AS project, u.display_name AS judge, u.email AS judge_email,
                r.status, r.raw_weighted AS weighted_score, r.submitted_at, r.overall_comment
           FROM reviews r JOIN assignments a ON a.id = r.assignment_id
           JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.judge_user_id
          WHERE a.event_id = ? ORDER BY p.name, u.display_name`, e);
      break;
    case "criterion-scores":
      rows = all(
        `SELECT p.name AS project, u.display_name AS judge, c.name AS criterion, c.weight,
                cs.score, c.scale_min, c.scale_max, cs.comment, r.status AS review_status
           FROM criterion_scores cs
           JOIN reviews r ON r.id = cs.review_id
           JOIN assignments a ON a.id = r.assignment_id
           JOIN projects p ON p.id = a.project_id
           JOIN users u ON u.id = a.judge_user_id
           JOIN criteria c ON c.id = cs.criterion_id
          WHERE a.event_id = ? ORDER BY p.name, u.display_name, c.sort_order`, e);
      break;
    case "results":
      rows = all(
        `SELECT rr.rank, p.name AS project, t.name AS team, IFNULL(tr.name,'') AS track,
                rr.normalized_mean, rr.raw_mean, rr.raw_rank, rr.rank_delta, rr.reviews_counted,
                s.algorithm, s.status AS snapshot_status, s.computed_at
           FROM result_rows rr
           JOIN result_snapshots s ON s.id = rr.snapshot_id
           JOIN projects p ON p.id = rr.project_id
           JOIN teams t ON t.id = p.team_id
           LEFT JOIN tracks tr ON tr.id = rr.track_id
          WHERE s.event_id = ?
            AND s.computed_at = (SELECT MAX(computed_at) FROM result_snapshots WHERE event_id = ?)
          ORDER BY rr.rank`, e, e);
      break;
    case "audit":
      rows = all(
        `SELECT created_at, actor_label, action, subject_type, subject_id, outcome, detail_json
           FROM audit_events WHERE event_id = ? ORDER BY created_at DESC`, e);
      break;
  }

  audit.record({ actor: cap.actor, eventId: e, action: "export.csv", subjectType: "export", subjectId: name, detail: { rows: rows.length } });
  return toCsv(rows, COLUMNS[name]);
}
