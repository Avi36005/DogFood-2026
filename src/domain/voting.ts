/**
 * Community voting (T3): approval voting with a budget. Each voter approves up to max_picks
 * projects (3 by default); a project's tally is the number of valid ballots that approve it.
 * Approval voting cannot be split the way one-person-one-vote can, and it gives a loud minority
 * no more weight per ballot than anyone else.
 *
 * Who votes: either signed-in accounts (never the event's judges or organizers, and never for
 * their own team's project), or holders of one-time codes the organizer prints for a venue.
 * Codes are the offline answer to "email-gated": no mail server, and one code is one ballot.
 *
 * What holds, in the backend:
 *   - the window, checked against the server clock inside the ballot's transaction;
 *   - one ballot per account and per code (unique indexes), final once cast (triggers);
 *   - the tally is visible to organizers only, until voting has closed and they publish it;
 *   - every voter sees the projects in their own seeded random order, so no project gains from
 *     sitting at the top of everybody's list;
 *   - ballots from one address are grouped for the organizer, flagged rather than refused (a
 *     venue shares one address), and an organizer can void a ballot with a written reason.
 * Every cast, void, setting change and publication is on the audit trail.
 */
import type { Store } from '../db/store.ts';
import { conflict, notFound, unauthorized, ValidationError } from '../util/errors.ts';
import { FormReader, type Body } from '../util/form.ts';
import { hashToken, hmac, newId } from '../util/tokens.ts';
import { formatUtc, iso } from '../util/time.ts';
import { AccessDenied, actsAsOrganizer, requireOrganizer, rolesIn } from './access.ts';
import { actorLabel, record } from './audit.ts';
import type { Actor, EventRow, UserRow } from './types.ts';
import { mulberry32 } from './uncertainty.ts';

export const VOTE_ACCESS = ['accounts', 'codes'] as const;
export type VoteAccess = (typeof VOTE_ACCESS)[number];
export const MAX_CODES_PER_BATCH = 500;
/** A cluster of this many valid ballots from one address is shown to the organizer. */
export const CLUSTER_AT = 3;

export interface VoteSettings {
  event_id: string;
  opens_at: string;
  closes_at: string;
  access: VoteAccess;
  max_picks: number;
  published_at: string | null;
  updated_at: string;
}

export type VotePhase = 'off' | 'upcoming' | 'open' | 'closed' | 'published';

export type Voter = { kind: 'account'; user: UserRow } | { kind: 'code'; codeId: string; code: string; batch: string };

export interface BallotChoice {
  id: string;
  title: string;
  summary: string;
  team_name: string;
  track_name: string | null;
  /** The voter's own team: shown, but cannot be approved. */
  own: boolean;
}

export interface TallyRow {
  project_id: string;
  title: string;
  team_name: string;
  votes: number;
  /** Share of valid ballots that approve this project. */
  share: number;
  rank: number;
}

export interface Tally {
  ballots: number;
  voided: number;
  rows: TallyRow[];
}

export interface BallotCluster {
  /** A short, stable label for the address; the address itself is never stored on a ballot. */
  address: string;
  ballots: { id: string; cast_at: string; voter: string; agent: string }[];
  sameAgent: number;
}

export function voteSettings(store: Store, eventId: string): VoteSettings | null {
  return store.get<VoteSettings>('SELECT * FROM vote_settings WHERE event_id = ?', [eventId]) ?? null;
}

export function votePhase(settings: VoteSettings | null, now: Date): VotePhase {
  if (!settings) return 'off';
  if (settings.published_at) return 'published';
  const at = iso(now);
  if (at < settings.opens_at) return 'upcoming';
  return at < settings.closes_at ? 'open' : 'closed';
}

// Organizer: settings, codes, review, publication ------------------------------------------

export function saveVoteSettings(store: Store, actor: Actor, event: EventRow, body: Body): VoteSettings {
  requireOrganizer(store, actor, event, `change the community vote of ${event.name}`);
  const form = new FormReader(body);
  const opens = form.instant('opens_at', { label: 'Voting opens', required: true });
  const closes = form.instant('closes_at', { label: 'Voting closes', required: true });
  const access = form.choice('access', VOTE_ACCESS, 'Who may vote');
  const maxPicks = form.int('max_picks', { label: 'Projects each voter may approve', min: 1, max: 10, fallback: 3 });
  if (opens && closes && closes <= opens) form.fail('closes_at', 'Voting must close after it opens.');
  const current = voteSettings(store, event.id);
  const cast = ballotCount(store, event.id);
  if (current?.published_at) form.fail('access', 'The vote is published. Its settings are part of the record now.');
  if (current && cast > 0) {
    if (access && access !== current.access) form.fail('access', `${cast} ballot(s) are cast, so who may vote is fixed.`);
    if (maxPicks !== current.max_picks) form.fail('max_picks', `${cast} ballot(s) are cast, so the number of approvals is fixed.`);
  }
  form.assertValid();

  const next = { opens_at: opens as string, closes_at: closes as string, access: access as VoteAccess, max_picks: maxPicks };
  return store.tx(() => {
    const now = iso(actor.now);
    store.run(
      `INSERT INTO vote_settings (event_id, opens_at, closes_at, access, max_picks, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET opens_at = excluded.opens_at, closes_at = excluded.closes_at,
         access = excluded.access, max_picks = excluded.max_picks, updated_at = excluded.updated_at`,
      [event.id, next.opens_at, next.closes_at, next.access, next.max_picks, now],
    );
    record(store, actor, {
      eventId: event.id,
      action: current ? 'vote.settings_changed' : 'vote.configured',
      subjectType: 'event',
      subjectId: event.id,
      summary: `${current ? 'Changed' : 'Set up'} the community vote: ${formatUtc(next.opens_at)} to ${formatUtc(next.closes_at)}, ${next.access === 'codes' ? 'one-time voter codes' : 'signed-in accounts'}, up to ${next.max_picks} approval(s) per ballot.`,
      detail: { from: current, to: next },
    });
    return voteSettings(store, event.id) as VoteSettings;
  });
}

/** Human-typeable codes, 12 characters from an alphabet without look-alikes, shown in groups of four. */
export function createVoterCodes(store: Store, actor: Actor, event: EventRow, count: number): { batch: string; codes: string[] } {
  requireOrganizer(store, actor, event, `create voter codes for ${event.name}`);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CODES_PER_BATCH) {
    throw new ValidationError({ count: `Create from 1 to ${MAX_CODES_PER_BATCH} codes at a time.` });
  }
  return store.tx(() => {
    const batches = store.get<{ n: number }>('SELECT count(DISTINCT batch) AS n FROM voter_codes WHERE event_id = ?', [event.id])?.n ?? 0;
    const batch = `batch ${batches + 1}`;
    const now = iso(actor.now);
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const raw = newId('v').slice(2);
      const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
      store.run('INSERT INTO voter_codes (id, event_id, code_hash, batch, created_at) VALUES (?, ?, ?, ?, ?)', [newId('vcd'), event.id, hashToken(normalizeCode(code)), batch, now]);
      codes.push(code);
    }
    record(store, actor, { eventId: event.id, action: 'vote.codes_created', subjectType: 'event', subjectId: event.id, summary: `Created ${count} one-time voter code(s) (${batch}). Only their hashes are stored; the codes were shown once.` });
    return { batch, codes };
  });
}

export function codeBatches(store: Store, eventId: string): { batch: string; total: number; used: number }[] {
  return store.all('SELECT batch, count(*) AS total, count(used_at) AS used FROM voter_codes WHERE event_id = ? GROUP BY batch ORDER BY min(created_at)', [eventId]);
}

export function voidBallot(store: Store, actor: Actor, event: EventRow, ballotId: string, body: Body): void {
  requireOrganizer(store, actor, event, `void a ballot in ${event.name}`);
  const form = new FormReader(body);
  const reason = form.text('reason', { label: 'Reason', required: true, max: 300 });
  form.assertValid();
  store.tx(() => {
    if (voteSettings(store, event.id)?.published_at) throw conflict('The vote is published. Its ballots are part of the record now.');
    const changed = store.run('UPDATE ballots SET voided_at = ?, voided_reason = ? WHERE id = ? AND event_id = ? AND voided_at IS NULL', [iso(actor.now), reason, ballotId, event.id]);
    if (changed.changes !== 1) throw notFound('No such valid ballot in this event.');
    record(store, actor, { eventId: event.id, action: 'vote.voided', subjectType: 'ballot', subjectId: ballotId, summary: `Voided ballot ${ballotId}: ${reason}` });
  });
}

export function publishVote(store: Store, actor: Actor, event: EventRow): void {
  requireOrganizer(store, actor, event, `publish the community vote of ${event.name}`);
  store.tx(() => {
    const settings = voteSettings(store, event.id);
    const phase = votePhase(settings, actor.now);
    if (phase === 'off') throw conflict('There is no community vote in this event.');
    if (phase === 'published') throw conflict('The vote is already published.');
    if (phase !== 'closed') throw conflict(`Voting is still ${phase === 'open' ? 'open' : 'to come'}; it closes ${formatUtc((settings as VoteSettings).closes_at)}.`);
    const now = iso(actor.now);
    store.run('UPDATE vote_settings SET published_at = ?, updated_at = ? WHERE event_id = ?', [now, now, event.id]);
    const tally = computeTally(store, event.id);
    record(store, actor, {
      eventId: event.id,
      action: 'vote.published',
      subjectType: 'event',
      subjectId: event.id,
      summary: `Published the community vote: ${tally.ballots} valid ballot(s), ${tally.voided} voided. Top: ${tally.rows.slice(0, 3).map((r) => `${r.rank}. ${r.title} (${r.votes})`).join(', ') || 'none'}.`,
    });
  });
}

/** Valid ballots from one address, grouped. Flagged for a human, never refused automatically. */
export function ballotClusters(store: Store, eventId: string): BallotCluster[] {
  const rows = store.all<{ id: string; cast_at: string; ip_hash: string | null; ua_hash: string | null; voter: string }>(
    `SELECT b.id, b.cast_at, b.ip_hash, b.ua_hash, coalesce(u.name, 'code ' || c.batch) AS voter
     FROM ballots b LEFT JOIN users u ON u.id = b.voter_user_id LEFT JOIN voter_codes c ON c.id = b.voter_code_id
     WHERE b.event_id = ? AND b.voided_at IS NULL AND b.ip_hash IS NOT NULL ORDER BY b.cast_at`,
    [eventId],
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) groups.set(row.ip_hash as string, [...(groups.get(row.ip_hash as string) ?? []), row]);
  return [...groups.entries()]
    .filter(([, list]) => list.length >= CLUSTER_AT)
    .map(([ip, list]) => {
      const agents = new Map<string, number>();
      for (const b of list) agents.set(b.ua_hash ?? '', (agents.get(b.ua_hash ?? '') ?? 0) + 1);
      return {
        address: ip.slice(0, 8),
        ballots: list.map((b) => ({ id: b.id, cast_at: b.cast_at, voter: b.voter, agent: (b.ua_hash ?? '').slice(0, 6) })),
        sameAgent: Math.max(...agents.values()),
      };
    })
    .sort((a, b) => b.ballots.length - a.ballots.length);
}

// Voters ------------------------------------------------------------------------------

export function normalizeCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Who is voting, checked against the event's access mode. Codes are looked up by hash; an
 * unknown or spent code is refused with the same message, so guessing learns nothing.
 */
export function resolveVoter(store: Store, actor: Actor, event: EventRow, settings: VoteSettings, code: string | null): Voter {
  if (settings.access === 'codes') {
    const normalized = normalizeCode(code ?? '');
    const row = normalized ? store.get<{ id: string; batch: string; used_at: string | null }>('SELECT id, batch, used_at FROM voter_codes WHERE event_id = ? AND code_hash = ?', [event.id, hashToken(normalized)]) : undefined;
    if (!row || row.used_at) throw new ValidationError({ code: 'That code is not valid for this vote, or it has been used.' }, 'That code is not valid for this vote, or it has been used.');
    return { kind: 'code', codeId: row.id, code: code as string, batch: row.batch };
  }
  if (!actor.user) throw unauthorized('Sign in to vote.');
  const roles = rolesIn(store, actor.user.id, event.id);
  if (roles.has('judge') || roles.has('organizer')) {
    throw new AccessDenied('Judges and organizers of this event do not take part in its community vote.', {
      eventId: event.id,
      action: 'access.denied',
      subjectType: 'vote',
      summary: `${actorLabel(actor)} was refused a community-vote ballot (they are a ${roles.has('judge') ? 'judge' : 'organizer'} of the event).`,
    });
  }
  return { kind: 'account', user: actor.user };
}

function ownProjectId(store: Store, voter: Voter, eventId: string): string | null {
  if (voter.kind !== 'account') return null;
  return store.get<{ id: string }>(
    `SELECT p.id FROM team_members m JOIN projects p ON p.team_id = m.team_id
     WHERE m.user_id = ? AND m.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL`,
    [voter.user.id, eventId],
  )?.id ?? null;
}

function voterKey(voter: Voter): string {
  return voter.kind === 'account' ? `account:${voter.user.id}` : `code:${voter.codeId}`;
}

export function existingBallot(store: Store, eventId: string, voter: Voter): { id: string; cast_at: string } | null {
  return (voter.kind === 'account'
    ? store.get<{ id: string; cast_at: string }>('SELECT id, cast_at FROM ballots WHERE event_id = ? AND voter_user_id = ?', [eventId, voter.user.id])
    : store.get<{ id: string; cast_at: string }>('SELECT id, cast_at FROM ballots WHERE voter_code_id = ?', [voter.codeId])) ?? null;
}

/**
 * The ballot, in this voter's own order: a Fisher–Yates shuffle seeded from an HMAC of the
 * event and the voter. The same voter sees the same order on every reload (so reloading cannot
 * be used to fish for a position), and different voters see different orders.
 */
export function ballotChoices(store: Store, event: EventRow, voter: Voter, secret: string): BallotChoice[] {
  const own = ownProjectId(store, voter, event.id);
  const projects = store.all<Omit<BallotChoice, 'own'>>(
    `SELECT p.id, p.title, p.summary, t.name AS team_name, tr.name AS track_name
     FROM projects p JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id
     WHERE p.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL ORDER BY p.id`,
    [event.id],
  );
  return shuffle(projects, ballotSeed(secret, event.id, voterKey(voter))).map((p) => ({ ...p, own: p.id === own }));
}

export function ballotSeed(secret: string, eventId: string, key: string): number {
  return Buffer.from(hmac(secret, `ballot-order:${eventId}:${key}`), 'base64url').readUInt32BE(0);
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function castBallot(store: Store, actor: Actor, event: EventRow, body: Body, secret: string, client: { userAgent: string }): { ballotId: string; picks: number } {
  const form = new FormReader(body);
  const picks = [...new Set(form.all('pick'))];
  return store.tx(() => {
    const settings = voteSettings(store, event.id);
    const phase = votePhase(settings, actor.now);
    if (!settings || phase === 'off') throw notFound('This event has no community vote.');
    if (phase === 'upcoming') throw conflict(`Voting opens ${formatUtc(settings.opens_at)}.`);
    if (phase !== 'open') throw conflict(`Voting closed ${formatUtc(settings.closes_at)}.`);
    const voter = resolveVoter(store, actor, event, settings, form.raw('code'));
    if (existingBallot(store, event.id, voter)) throw conflict('A ballot has already been cast with this ' + (voter.kind === 'account' ? 'account.' : 'code.'));

    const valid = new Set(ballotChoices(store, event, voter, secret).filter((c) => !c.own).map((c) => c.id));
    if (picks.length === 0) form.fail('pick', 'Approve at least one project.');
    else if (picks.length > settings.max_picks) form.fail('pick', `Approve at most ${settings.max_picks} project(s).`);
    else if (picks.some((p) => !valid.has(p))) form.fail('pick', 'A chosen project is not on this ballot (your own team’s project cannot be approved).');
    form.assertValid();

    const ballotId = newId('bal');
    const now = iso(actor.now);
    store.run(
      'INSERT INTO ballots (id, event_id, voter_user_id, voter_code_id, cast_at, ip_hash, ua_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ballotId, event.id, voter.kind === 'account' ? voter.user.id : null, voter.kind === 'code' ? voter.codeId : null, now,
        actor.ip ? hmac(secret, `ip:${event.id}:${actor.ip}`) : null, hmac(secret, `ua:${event.id}:${client.userAgent}`)],
    );
    for (const projectId of picks) store.run('INSERT INTO ballot_picks (ballot_id, project_id) VALUES (?, ?)', [ballotId, projectId]);
    if (voter.kind === 'code') {
      const spent = store.run('UPDATE voter_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, voter.codeId]);
      if (spent.changes !== 1) throw conflict('A ballot has already been cast with this code.');
    }
    record(store, actor, {
      eventId: event.id,
      action: 'vote.cast',
      subjectType: 'ballot',
      subjectId: ballotId,
      summary: `A ballot approving ${picks.length} project(s) was cast by ${voter.kind === 'account' ? actorLabel(actor) : `a voter code from ${voter.batch}`}.`,
    });
    return { ballotId, picks: picks.length };
  });
}

// Tallies --------------------------------------------------------------------------------

function ballotCount(store: Store, eventId: string): number {
  return store.get<{ n: number }>('SELECT count(*) AS n FROM ballots WHERE event_id = ?', [eventId])?.n ?? 0;
}

export function computeTally(store: Store, eventId: string): Tally {
  const counts = store.get<{ valid: number; voided: number }>(
    'SELECT count(*) FILTER (WHERE voided_at IS NULL) AS valid, count(*) FILTER (WHERE voided_at IS NOT NULL) AS voided FROM ballots WHERE event_id = ?',
    [eventId],
  ) ?? { valid: 0, voided: 0 };
  const rows = store.all<Omit<TallyRow, 'share' | 'rank'>>(
    `SELECT p.id AS project_id, p.title, t.name AS team_name,
       (SELECT count(*) FROM ballot_picks k JOIN ballots b ON b.id = k.ballot_id WHERE k.project_id = p.id AND b.voided_at IS NULL) AS votes
     FROM projects p JOIN teams t ON t.id = p.team_id
     WHERE p.event_id = ? AND p.status = 'submitted' AND p.superseded_by IS NULL
     ORDER BY votes DESC, p.title`,
    [eventId],
  );
  let previous = -1;
  let rank = 0;
  const ranked = rows.map((row, index) => {
    if (row.votes !== previous) rank = index + 1;
    previous = row.votes;
    return { ...row, share: counts.valid ? row.votes / counts.valid : 0, rank };
  });
  return { ballots: counts.valid, voided: counts.voided, rows: ranked };
}

/** The tally, if this caller may see it: organizers always, everyone else once published. */
export function visibleTally(store: Store, actor: Actor, event: EventRow): Tally | null {
  const settings = voteSettings(store, event.id);
  if (!settings) return null;
  if (!settings.published_at && !actsAsOrganizer(store, actor, event.id, 'read the unpublished vote tally')) return null;
  return computeTally(store, event.id);
}
