/**
 * Compare mode: pairwise judging on top of the normal assignments. A judge is shown two of
 * their own assigned, live projects and says which is better. The pair is chosen by
 * pairwise.ts `nextPair` (least compared, then closest in strength), the choice is stored once
 * and for good, and every choice is on the audit trail. Judges only ever compare projects they
 * were assigned, so track isolation and conflict rules carry over unchanged, and nobody sees
 * another judge's choices.
 */
import type { Store } from '../db/store.ts';
import { conflict, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { newId } from '../util/tokens.ts';
import { iso } from '../util/time.ts';
import { AccessDenied, requireRole } from './access.ts';
import { actorLabel, record } from './audit.ts';
import { assertJudgingOpen, judgingOpen } from './events.ts';
import { fitBradleyTerry, impliedComparisons, nextPair, orderByStrength, pairKey, spearman, type BradleyTerryFit, type Comparison } from './pairwise.ts';
import { computeStandings, reviewInputs } from './results.ts';
import type { Actor, EventRow } from './types.ts';

export interface CompareProject {
  id: string;
  title: string;
  summary: string;
  team_name: string;
  track_name: string | null;
  repo_url: string;
  demo_url: string;
  video_url: string;
}

export interface CompareView {
  event: EventRow;
  open: boolean;
  pair: [CompareProject, CompareProject] | null;
  made: number;
  possible: number;
}

export interface PairwiseSummary {
  explicit: number;
  implied: number;
  fit: BradleyTerryFit;
  order: { project_id: string; title: string; theta: number; wins: number; losses: number; rubricRank: number | null }[];
  agreement: { rho: number; n: number };
  sameWinner: boolean;
}

function assignedLive(store: Store, eventId: string, judgeId: string): CompareProject[] {
  return store.all<CompareProject>(
    `SELECT p.id, p.title, p.summary, t.name AS team_name, tr.name AS track_name, p.repo_url, p.demo_url, p.video_url
     FROM assignments a JOIN projects p ON p.id = a.project_id JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id
     WHERE a.event_id = ? AND a.judge_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL ORDER BY p.id`,
    [eventId, judgeId],
  );
}

function explicitComparisons(store: Store, eventId: string): Comparison[] {
  return store.all<{ judge: string; winner: string; loser: string }>(
    'SELECT judge_id AS judge, winner_id AS winner, loser_id AS loser FROM pairwise_votes WHERE event_id = ? ORDER BY created_at, id',
    [eventId],
  );
}

/** Implied comparisons from every judge's rubric scores, plus the explicit choices of compare mode. */
export function allComparisons(store: Store, event: EventRow): { explicit: Comparison[]; implied: Comparison[] } {
  return { explicit: explicitComparisons(store, event.id), implied: impliedComparisons(reviewInputs(store, event).observations) };
}

export function compareView(store: Store, actor: Actor, event: EventRow): CompareView {
  const judge = requireRole(store, actor, event, ['judge'], `open compare mode in ${event.name}`);
  const projects = assignedLive(store, event.id, judge.id);
  const own = store.all<{ winner_id: string; loser_id: string }>('SELECT winner_id, loser_id FROM pairwise_votes WHERE event_id = ? AND judge_id = ?', [event.id, judge.id]);
  const done = new Set(own.map((v) => pairKey(v.winner_id, v.loser_id)));
  const { explicit, implied } = allComparisons(store, event);
  const counts = new Map<string, number>();
  for (const c of [...explicit, ...implied]) counts.set(pairKey(c.winner, c.loser), (counts.get(pairKey(c.winner, c.loser)) ?? 0) + 1);
  const next = nextPair(projects.map((p) => p.id), done, counts, fitBradleyTerry([...explicit, ...implied]));
  const byId = new Map(projects.map((p) => [p.id, p]));
  return {
    event,
    open: judgingOpen(event, actor.now),
    pair: next ? [byId.get(next[0]) as CompareProject, byId.get(next[1]) as CompareProject] : null,
    made: own.length,
    possible: (projects.length * (projects.length - 1)) / 2,
  };
}

export function recordChoice(store: Store, actor: Actor, event: EventRow, body: Body): void {
  const form = new FormReader(body);
  const winner = form.raw('winner');
  const loser = form.raw('loser');
  store.tx(() => {
    const judge = requireRole(store, actor, event, ['judge'], `record a pairwise choice in ${event.name}`);
    assertJudgingOpen(event, actor.now);
    if (!winner || !loser || winner === loser) throw new ValidationError({ winner: 'Choose one of the two projects.' });
    const mine = new Set(assignedLive(store, event.id, judge.id).map((p) => p.id));
    if (!mine.has(winner) || !mine.has(loser)) {
      throw new AccessDenied('You can only compare projects assigned to you.', {
        eventId: event.id,
        action: 'access.denied',
        subjectType: 'pairwise',
        summary: `${actorLabel(actor)} was refused: compare projects not assigned to them (${winner} vs ${loser}).`,
      });
    }
    if (store.get('SELECT 1 FROM pairwise_votes WHERE event_id = ? AND judge_id = ? AND min(winner_id, loser_id) = min(?, ?) AND max(winner_id, loser_id) = max(?, ?)', [event.id, judge.id, winner, loser, winner, loser])) {
      throw conflict('You have already compared these two projects.');
    }
    const id = newId('pw');
    store.run('INSERT INTO pairwise_votes (id, event_id, judge_id, winner_id, loser_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, event.id, judge.id, winner, loser, iso(actor.now)]);
    record(store, actor, { eventId: event.id, action: 'pairwise.chosen', subjectType: 'pairwise', subjectId: id, summary: `${actorLabel(actor)} compared ${winner} and ${loser} in compare mode.` });
  });
}

/** The organizer's second opinion: Bradley–Terry on all comparisons, beside the rubric ranking. */
export function pairwiseSummary(store: Store, event: EventRow): PairwiseSummary | null {
  const { explicit, implied } = allComparisons(store, event);
  if (explicit.length + implied.length === 0) return null;
  const fit = fitBradleyTerry([...explicit, ...implied]);
  const order = orderByStrength(fit);
  const standings = computeStandings(store, event).standings.filter((s) => s.rank !== null);
  const rubricOrder = standings.map((s) => s.project_id);
  const info = new Map(standings.map((s) => [s.project_id, s]));
  return {
    explicit: explicit.length,
    implied: implied.length,
    fit,
    order: order.map((p) => ({ project_id: p, title: info.get(p)?.title ?? p, theta: fit.theta.get(p) ?? 0, wins: fit.wins.get(p) ?? 0, losses: fit.losses.get(p) ?? 0, rubricRank: info.get(p)?.rank ?? null })),
    agreement: spearman(rubricOrder, order),
    sameWinner: rubricOrder[0] !== undefined && rubricOrder[0] === order[0],
  };
}
