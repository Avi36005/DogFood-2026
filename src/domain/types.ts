/** Row shapes as they come out of SQLite. Integers that are booleans stay 0/1 here. */

export type Role = 'organizer' | 'judge' | 'participant';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  is_admin: 0 | 1;
  created_at: string;
}

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  submissions_open_at: string | null;
  submissions_close_at: string;
  judging_close_at: string | null;
  results_published_at: string | null;
  max_team_size: number;
  reviews_per_project: number;
  score_min: number;
  score_max: number;
  source: 'created' | 'fixture';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackRow {
  id: string;
  event_id: string;
  name: string;
  description: string;
  position: number;
}

export interface PrizeRow {
  id: string;
  event_id: string;
  track_id: string | null;
  name: string;
  description: string;
  position: number;
}

export interface TeamRow {
  id: string;
  event_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

export type ProjectStatus = 'draft' | 'submitted' | 'withdrawn';

export interface ProjectRow {
  id: string;
  event_id: string;
  team_id: string;
  track_id: string | null;
  title: string;
  summary: string;
  description: string;
  repo_url: string;
  demo_url: string;
  video_url: string;
  status: ProjectStatus;
  submitted_at: string | null;
  superseded_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CriterionRow {
  id: string;
  event_id: string;
  key: string;
  name: string;
  description: string;
  weight: number;
  position: number;
}

export interface AssignmentRow {
  id: string;
  event_id: string;
  project_id: string;
  judge_id: string;
  source: 'fixture' | 'auto' | 'manual';
  created_by: string | null;
  created_at: string;
}

export interface ReviewRow {
  assignment_id: string;
  status: 'draft' | 'submitted';
  comment: string;
  submitted_at: string | null;
  updated_at: string;
}

/** Who is acting, from where, and at what server time. Every domain call takes one. */
export interface Actor {
  user: UserRow | null;
  ip: string | null;
  now: Date;
}

export function systemActor(now = new Date()): Actor {
  return { user: null, ip: null, now };
}
