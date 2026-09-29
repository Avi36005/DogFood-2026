/**
 * Verifiable records (T4): a signed certificate for every ranked project, and a signed record of
 * every judge's reviews. Both are built from the published, signed results snapshot and signed
 * with the instance's Ed25519 key, so they are deterministic: the same snapshot always yields the
 * same bytes and the same signature, and nothing new is stored.
 *
 * A certificate quotes the SHA-256 of the signed results document it came from, so it can be tied
 * back to the public results.json. A judge record lists the judge's own reviews and, once results
 * are published, the rows of the signed inputs that carry the judge's pseudonym: the judge can
 * check that every review they submitted was counted, at the value they gave.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { notFound } from '../util/errors.ts';
import { currentEvidence, type ResultsDocument } from './evidence.ts';
import { judgeScores } from './judging.ts';
import { publishedResults, reviewInputs } from './results.ts';
import { signingKey, signText, verifyText } from './signing.ts';
import type { Actor, EventRow } from './types.ts';

export const CERTIFICATE_FORMAT = 'forgeboard-certificate/v1';
export const JUDGE_RECORD_FORMAT = 'forgeboard-judge-record/v1';

export interface SignedRecord {
  format: string;
  signature_algorithm: 'Ed25519';
  public_key: string;
  signature: string;
  /** The signed bytes, exactly. */
  document_text: string;
  document: unknown;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function sealed(store: Store, format: string, document: Record<string, unknown>): SignedRecord {
  const key = signingKey(store);
  const text = JSON.stringify({ format, ...document });
  return { format, signature_algorithm: 'Ed25519', public_key: key.publicKey, signature: signText(key, text), document_text: text, document: JSON.parse(text) };
}

export interface Certificate {
  format: typeof CERTIFICATE_FORMAT;
  event: { id: string; slug: string; name: string };
  project: { id: string; title: string; team: string; members: string[]; track: string | null };
  result: { rank: number; of: number; score: number; raw_mean: number; reviews: number; rank_interval: [number, number] | null; podium_share: number | null };
  results: { snapshot: string; published_at: string; document_sha256: string };
  issued_at: string;
}

/** The signed certificate of one ranked project. Public once results are published. */
export function projectCertificate(store: Store, event: EventRow, projectId: string): SignedRecord {
  const published = publishedResults(store, event);
  const evidence = currentEvidence(store, event);
  const row = published?.rows.find((r) => r.project_id === projectId);
  if (!published || !evidence || !row) throw notFound('No certificate: that project is not in the published results.');
  const members = store
    .all<{ name: string }>('SELECT u.name FROM projects p JOIN team_members m ON m.team_id = p.team_id JOIN users u ON u.id = m.user_id WHERE p.id = ? ORDER BY m.is_captain DESC, u.name', [projectId])
    .map((m) => m.name);
  return sealed(store, CERTIFICATE_FORMAT, {
    event: { id: event.id, slug: event.slug, name: event.name },
    project: { id: row.project_id, title: row.title, team: row.team_name, members, track: row.track_name },
    result: {
      rank: row.rank,
      of: published.rows.length,
      score: row.score,
      raw_mean: row.raw_mean,
      reviews: row.review_count,
      rank_interval: row.rank_lo !== null && row.rank_hi !== null ? [row.rank_lo, row.rank_hi] : null,
      podium_share: row.podium_share,
    },
    results: { snapshot: published.snapshot.id, published_at: published.snapshot.published_at, document_sha256: sha256(evidence.documentText) },
    issued_at: published.snapshot.published_at,
  });
}

export interface JudgeRecord {
  format: typeof JUDGE_RECORD_FORMAT;
  event: { id: string; slug: string; name: string };
  judge: { id: string; name: string };
  reviews: { project: string; title: string; criteria: Record<string, number>; weighted: number | null; comment_sha256: string; submitted_at: string | null }[];
  results: null | {
    snapshot: string;
    document_sha256: string;
    inputs_fingerprint: string;
    pseudonym: string | null;
    counted: { project: string; score: number }[];
    not_counted: { project: string; reason: string }[];
    all_counted: boolean;
  };
  issued_at: string;
}

/**
 * The signed record of one judge's submitted reviews. Who may read it is exactly who may read the
 * scores: the judge themselves, an organizer of the event, or an administrator (audited). The
 * check is judgeScores's own, so refusals land on the audit trail the same way.
 */
export function judgeRecord(store: Store, actor: Actor, event: EventRow, judgeId?: string): SignedRecord {
  const scores = judgeScores(store, actor, { judge: judgeId ?? null, event: event.id });
  const submitted = scores.scores.filter((s) => s.status === 'submitted' && s.event_id === event.id);
  const reviews = submitted.map((s) => ({ project: s.project_id, title: s.project_title, criteria: s.criteria, weighted: s.weighted, comment_sha256: sha256(s.comment), submitted_at: s.submitted_at }));
  const evidence = event.results_published_at ? currentEvidence(store, event) : null;
  let results: JudgeRecord['results'] = null;
  if (evidence) {
    const document = JSON.parse(evidence.documentText) as ResultsDocument;
    // The same aliasing as pseudonymousInputs: judges in id order become J01, J02… Judging closed
    // when results were published, so the submitted reviews are the ones that were signed.
    const judges = [...new Set(reviewInputs(store, event).observations.map((o) => o.judge))].sort();
    const index = judges.indexOf(scores.judge.id);
    const alias = index >= 0 ? `J${String(index + 1).padStart(Math.max(2, String(judges.length).length), '0')}` : null;
    const counted = evidence.inputs.filter((row) => row[0] === alias).map((row) => ({ project: row[1], score: row[2] }));
    const notCounted = reviews
      .filter((r) => !counted.some((c) => c.project === r.project && r.weighted !== null && Math.abs(c.score - r.weighted) < 1e-9))
      .map((r) => {
        const project = store.get<{ superseded_by: string | null; status: string }>('SELECT superseded_by, status FROM projects WHERE id = ?', [r.project]);
        return { project: r.project, reason: project?.superseded_by ? `superseded by ${project.superseded_by} (duplicate submission)` : project?.status === 'withdrawn' ? 'project withdrawn' : 'not in the signed inputs' };
      });
    results = {
      snapshot: evidence.snapshotId,
      document_sha256: sha256(evidence.documentText),
      inputs_fingerprint: document.inputs.fingerprint,
      pseudonym: alias,
      counted,
      not_counted: notCounted,
      all_counted: notCounted.every((n) => n.reason !== 'not in the signed inputs'),
    };
  }
  return sealed(store, JUDGE_RECORD_FORMAT, {
    event: { id: event.id, slug: event.slug, name: event.name },
    judge: scores.judge,
    reviews,
    results,
    issued_at: evidence ? (JSON.parse(evidence.documentText) as ResultsDocument).published_at : new Date(actor.now).toISOString(),
  });
}

export interface RecordCheck {
  valid: boolean;
  signed_by_this_instance: boolean;
  format: string | null;
  problems: string[];
}

/** Checks any signed record (certificate, judge record or results document). */
export function verifyRecord(store: Store, record: { document_text?: unknown; signature?: unknown; public_key?: unknown }): RecordCheck {
  const problems: string[] = [];
  const text = typeof record.document_text === 'string' ? record.document_text : null;
  const signature = typeof record.signature === 'string' ? record.signature : null;
  const publicKey = typeof record.public_key === 'string' ? record.public_key : signingKey(store).publicKey;
  if (!text || !signature) return { valid: false, signed_by_this_instance: false, format: null, problems: ['Send document_text and signature, exactly as issued.'] };
  let format: string | null = null;
  try {
    format = (JSON.parse(text) as { format?: string }).format ?? null;
  } catch {
    problems.push('document_text is not JSON.');
  }
  const valid = verifyText(text, signature, publicKey);
  if (!valid) problems.push('The signature does not match: the record was changed after signing, or signed by another key.');
  const mine = publicKey === signingKey(store).publicKey;
  if (!mine) problems.push("It was signed by another key than this instance's.");
  return { valid, signed_by_this_instance: valid && mine, format, problems };
}
