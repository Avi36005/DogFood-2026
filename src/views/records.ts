import type { Ctx } from '../http/context.ts';
import type { Certificate, SignedRecord } from '../domain/records.ts';
import type { EventRow } from '../domain/types.ts';
import { linkButton, num, pageHeader, pill, section } from './components.ts';
import { html } from './html.ts';
import { page } from './layout.ts';

/** A printable certificate, with its signature and how to check it. */
export function certificatePage(ctx: Ctx, event: EventRow, record: SignedRecord, valid: boolean): SafeHtmlLike {
  const c = record.document as Certificate;
  const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
  const json = `/events/${event.slug}/certificates/${c.project.id}/signed.json`;
  return page(ctx, {
    title: `Certificate: ${c.project.title}`,
    body: html`
${pageHeader(c.project.title, { eyebrow: `${c.event.name} · certificate`, lead: html`${c.project.team}${c.project.track ? html` · ${c.project.track}` : ''}` })}
<div class="card certificate">
  <p class="certificate-rank">Placed <strong>${ordinal(c.result.rank)}</strong> of ${c.result.of}</p>
  <p>Normalized score ${num(c.result.score, 3)} (raw mean ${num(c.result.raw_mean, 3)}) from ${c.result.reviews} review${c.result.reviews === 1 ? '' : 's'}${c.result.rank_interval ? html`; 90% of refits place it between ${c.result.rank_interval[0]} and ${c.result.rank_interval[1]}` : ''}.</p>
  ${c.project.members.length ? html`<p>Team: ${c.project.members.join(', ')}</p>` : ''}
  <p>Issued with the results published ${c.issued_at.slice(0, 16).replace('T', ' ')} UTC.</p>
</div>
${section(
  'Check it',
  html`
<p>${valid ? pill('Signature valid', 'success') : pill('Signature does not verify', 'danger')} Ed25519, signed by this instance's key, over the exact text in the signed JSON.</p>
<p>It quotes the SHA-256 of the signed results document (<code>${c.results.document_sha256.slice(0, 16)}…</code>), the one at <a href="/events/${event.slug}/results.json">results.json</a>.</p>
<p>Offline: save the signed JSON and run <code>node src/cli.ts verify-record certificate.json</code>. Online: <code>POST /api/verify</code> with the same JSON.</p>
<p>${linkButton(json, 'Signed JSON', 'secondary')} ${linkButton(`/events/${event.slug}/results`, 'All results', 'secondary')}</p>`,
  { id: 'verify' },
)}`,
  });
}

type SafeHtmlLike = ReturnType<typeof page>;
