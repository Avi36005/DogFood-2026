/**
 * The signed results document: what a published ranking claims, in a form anyone can check
 * without trusting this server.
 *
 * At publication Forgeboard writes one JSON document (canonical: the exact text is stored and
 * signed, so nothing is re-serialized later) holding the ranking with its rank intervals, the
 * method, λ and weights, whether the method matches what was fixed when scoring began, the
 * audit chain's head at that moment, and a SHA-256 fingerprint of the model's inputs. The inputs
 * themselves (one weighted score per review, judges pseudonymized as J01, J02…) are stored with
 * the snapshot and ship in the organizer's results capsule, where they are refitted and compared.
 *
 * Checks, all offline: (1) the Ed25519 signature matches the document; (2) the inputs hash to the
 * fingerprint the document quotes; (3) refitting the inputs with the documented method gives the
 * documented scores and ranks.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import type { ChainHead } from './audit.ts';
import type { CommitmentStatus } from './commitment.ts';
import { fitOffsets, type Observation } from './normalization.ts';
import type { Standings } from './results.ts';
import { verifyText } from './signing.ts';
import type { EventRow } from './types.ts';

export const DOCUMENT_FORMAT = 'forgeboard-results/v1';

/** [judge pseudonym, project id, weighted score], sorted. */
export type InputRow = [string, string, number];

export interface RankingEntry {
  project: string;
  title: string;
  team: string;
  rank: number;
  score: number;
  raw_mean: number;
  reviews: number;
  rank_interval: [number, number] | null;
  podium_share: number | null;
}

export interface ResultsDocument {
  format: typeof DOCUMENT_FORMAT;
  event: { id: string; slug: string; name: string; scale: [number, number] };
  snapshot: string;
  published_at: string;
  method: {
    name: string;
    lambda: number;
    weights: Record<string, number>;
    commitment: { committed_at: string; fingerprint: string; unchanged: boolean; later_rubric_edits: number } | null;
  };
  inputs: { reviews: number; judges: number; fingerprint: string };
  audit_anchor: ChainHead | null;
  ranking: RankingEntry[];
  certainty: {
    replicates: number;
    seed: number;
    level: number;
    sigma: number;
    refits: number;
    winner_holds: number;
    podium_holds: number;
    judges_who_change_podium: number;
    prize_line: { place: number; above: string; below: string; gap: number; order_share: number; reviews_each: number | null }[];
  } | null;
}

export interface Bundle {
  document_text: string;
  signature: string;
  public_key: string;
  inputs?: InputRow[];
}

export interface VerifyReport {
  signature: boolean;
  /** null when the bundle carries no inputs. */
  fingerprint: boolean | null;
  refit: boolean | null;
  problems: string[];
}

/** Judges become J01, J02… in the order of their ids, so the refit visits them in the same order. */
export function pseudonymousInputs(observations: readonly Observation[]): InputRow[] {
  const judges = [...new Set(observations.map((o) => o.judge))].sort();
  const width = Math.max(2, String(judges.length).length);
  const alias = new Map(judges.map((j, i) => [j, `J${String(i + 1).padStart(width, '0')}`]));
  return observations
    .map((o): InputRow => [alias.get(o.judge) as string, o.project, o.score])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]));
}

export function inputsFingerprint(inputs: readonly InputRow[]): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function buildDocument(args: {
  event: EventRow;
  snapshotId: string;
  publishedAt: string;
  result: Standings;
  inputs: readonly InputRow[];
  anchor: ChainHead | null;
  commitment: CommitmentStatus | null;
}): ResultsDocument {
  const { event, result, inputs } = args;
  const u = result.uncertainty;
  return {
    format: DOCUMENT_FORMAT,
    event: { id: event.id, slug: event.slug, name: event.name, scale: [event.score_min, event.score_max] },
    snapshot: args.snapshotId,
    published_at: args.publishedAt,
    method: {
      name: result.method,
      lambda: result.lambda,
      weights: Object.fromEntries(result.weights.map((w) => [w.key, w.weight])),
      commitment: args.commitment
        ? { committed_at: args.commitment.committedAt, fingerprint: args.commitment.committedHash, unchanged: args.commitment.unchanged, later_rubric_edits: args.commitment.laterRubricChanges }
        : null,
    },
    inputs: { reviews: inputs.length, judges: new Set(inputs.map((i) => i[0])).size, fingerprint: inputsFingerprint(inputs) },
    audit_anchor: args.anchor,
    ranking: result.standings
      .filter((s) => s.rank !== null && s.score !== null && s.raw_mean !== null)
      .map((s) => ({
        project: s.project_id,
        title: s.title,
        team: s.team_name,
        rank: s.rank as number,
        score: s.score as number,
        raw_mean: s.raw_mean as number,
        reviews: s.review_count,
        rank_interval: s.rank_lo !== null && s.rank_hi !== null ? [s.rank_lo, s.rank_hi] : null,
        podium_share: s.podium_share,
      })),
    certainty: u
      ? {
          replicates: u.replicates,
          seed: u.seed,
          level: u.level,
          sigma: u.sigma,
          refits: u.stability.refits,
          winner_holds: u.stability.winnerHolds,
          podium_holds: u.stability.podiumHolds,
          judges_who_change_podium: u.stability.influential.length,
          prize_line: u.separations.map((s) => ({ place: s.place, above: s.above, below: s.below, gap: s.gap, order_share: s.orderShare, reviews_each: s.reviewsEach })),
        }
      : null,
  };
}

/** Competition rank from scores alone: 1 + the number of projects scoring clearly higher. */
export function ranksFromScores(scores: ReadonlyMap<string, number>): Map<string, number> {
  const values = [...scores.values()];
  return new Map([...scores].map(([p, v]) => [p, 1 + values.filter((w) => w > v + 1e-9).length]));
}

export function verifyBundle(bundle: Bundle): VerifyReport {
  const problems: string[] = [];
  const signature = verifyText(bundle.document_text, bundle.signature, bundle.public_key);
  if (!signature) problems.push('The signature does not match the document: it was changed after signing, or signed by another key.');
  let doc: ResultsDocument;
  try {
    doc = JSON.parse(bundle.document_text) as ResultsDocument;
  } catch {
    return { signature, fingerprint: null, refit: null, problems: [...problems, 'The document is not valid JSON.'] };
  }
  if (!bundle.inputs) return { signature, fingerprint: null, refit: null, problems };

  const fingerprint = inputsFingerprint(bundle.inputs) === doc.inputs.fingerprint;
  if (!fingerprint) problems.push('The inputs do not hash to the fingerprint in the signed document.');

  const observations = bundle.inputs.map(([judge, project, score]) => ({ judge, project, score }));
  const model = fitOffsets(observations, { lambda: doc.method.lambda });
  const scores = new Map([...model.projectEffect].map(([p, a]) => [p, model.mu + a]));
  const ranks = ranksFromScores(scores);
  let refit = scores.size === doc.ranking.length;
  if (!refit) problems.push(`The inputs rank ${scores.size} projects; the document ranks ${doc.ranking.length}.`);
  for (const entry of doc.ranking) {
    const score = scores.get(entry.project);
    if (score === undefined || Math.abs(score - entry.score) > 1e-6 || ranks.get(entry.project) !== entry.rank) {
      refit = false;
      problems.push(`${entry.title}: refitting gives ${score === undefined ? 'no score' : `${score.toFixed(6)} (rank ${ranks.get(entry.project)})`}, the document says ${entry.score.toFixed(6)} (rank ${entry.rank}).`);
    }
  }
  return { signature, fingerprint, refit, problems };
}

/**
 * Reads a signed results file in either format: the JSON served at /events/<slug>/results.json,
 * or a results capsule (.html), whose data blocks also carry the inputs.
 */
export function parseBundle(text: string): Bundle {
  if (/^\s*</.test(text)) {
    const block = (id: string) => {
      const match = text.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`));
      if (!match?.[1]) throw new Error(`no ${id} block: this is not a Forgeboard results capsule`);
      return JSON.parse(match[1]) as unknown;
    };
    return { document_text: block('doc-text') as string, signature: block('signature') as string, public_key: block('public-key') as string, inputs: block('inputs') as InputRow[] };
  }
  const json = JSON.parse(text) as Partial<Bundle>;
  if (typeof json.document_text !== 'string' || typeof json.signature !== 'string' || typeof json.public_key !== 'string') {
    throw new Error('expected document_text, signature and public_key (the response of /events/<slug>/results.json)');
  }
  return { document_text: json.document_text, signature: json.signature, public_key: json.public_key, inputs: json.inputs };
}

export interface StoredEvidence {
  snapshotId: string;
  documentText: string;
  signature: string;
  publicKey: string;
  inputs: InputRow[];
}

/** The signed document of the current published snapshot, if the event has one. */
export function currentEvidence(store: Store, event: EventRow): StoredEvidence | null {
  if (!event.results_published_at) return null;
  const row = store.get<{ id: string; document: string | null; signature: string | null; public_key: string | null; inputs: string | null }>(
    'SELECT id, document, signature, public_key, inputs FROM result_snapshots WHERE event_id = ? AND superseded_at IS NULL',
    [event.id],
  );
  if (!row?.document || !row.signature || !row.public_key) return null;
  return { snapshotId: row.id, documentText: row.document, signature: row.signature, publicKey: row.public_key, inputs: row.inputs ? (JSON.parse(row.inputs) as InputRow[]) : [] };
}
