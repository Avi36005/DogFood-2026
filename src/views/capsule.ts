/**
 * The results capsule: one self-contained HTML file an organizer downloads after publishing and
 * can hand to anyone. Opened in a browser, with no server and no network, it checks itself:
 *
 *   1. the Ed25519 signature over the results document (WebCrypto),
 *   2. that the embedded inputs hash to the fingerprint the signed document quotes (SHA-256),
 *   3. that refitting those inputs with the documented method gives the documented ranking
 *      (the same coordinate-descent fit as src/domain/normalization.ts, restated in 30 lines).
 *
 * Everything is inline. Data sits in JSON script blocks with "<" escaped, so no value from the
 * event can close the block or run as markup.
 */
import type { ResultsDocument, StoredEvidence } from '../domain/evidence.ts';
import { escapeHtml as e } from './html.ts';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function capsuleFileName(doc: ResultsDocument): string {
  return `${doc.event.slug}-results-${doc.snapshot}.html`;
}

export function resultsCapsule(evidence: StoredEvidence): string {
  const doc = JSON.parse(evidence.documentText) as ResultsDocument;
  const pct = (v: number | null) => (v === null ? '' : `${Math.round(v * 100)}%`);
  const rows = doc.ranking
    .map((r) => `<tr><td class="n">${r.rank}</td><td>${e(r.title)}<br><small>${e(r.team)} · <code>${e(r.project)}</code></small></td><td class="n">${r.score.toFixed(3)}</td><td class="n">${r.raw_mean.toFixed(3)}</td><td class="n">${r.rank_interval ? `${r.rank_interval[0]}–${r.rank_interval[1]}` : ''}</td><td class="n">${pct(r.podium_share)}</td><td class="n">${r.reviews}</td></tr>`)
    .join('');
  const c = doc.certainty;
  const commitment = doc.method.commitment;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(doc.event.name)}: signed results</title>
<style>
:root{--bg:#f6f8f9;--panel:#fff;--ink:#0d1417;--muted:#56656e;--rule:#d5dce0;--ok:#0b7a3e;--bad:#b42318;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#05080d;--panel:#0b1119;--ink:#e9f0f5;--muted:#9aa8b3;--rule:#233040;--ok:#2bd48a;--bad:#fb5a61;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}
p{margin:6px 0;max-width:72ch}small,.muted{color:var(--muted)}
code{font:13px ui-monospace,Menlo,monospace}
.checks{list-style:none;padding:0;margin:14px 0;display:grid;gap:8px}
.checks li{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:10px 14px}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--rule);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:7px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted)}.n{text-align:right;font-variant-numeric:tabular-nums}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
</style>
</head>
<body>
<main>
<h1>${e(doc.event.name)}: results</h1>
<p class="muted">Published ${e(doc.published_at)} · snapshot <code>${e(doc.snapshot)}</code> · ${doc.inputs.reviews} reviews by ${doc.inputs.judges} judges</p>
<p>This file checks itself. It needs no server and no network; the checks below ran in your browser when you opened it.</p>
<ul class="checks" id="checks">
  <li id="c-sig">Signature: checking…</li>
  <li id="c-fp">Inputs fingerprint: checking…</li>
  <li id="c-fit">Refit of the ranking: checking…</li>
</ul>
<h2>Ranking</h2>
<div class="wrap"><table>
<thead><tr><th class="n">Rank</th><th>Project</th><th class="n">Score</th><th class="n">Raw mean</th><th class="n">Likely place (${c ? Math.round(c.level * 100) : 90}%)</th><th class="n">Top ${c ? c.prize_line.length || 3 : 3}</th><th class="n">Reviews</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<h2>How sure is this?</h2>
${c ? `<p>First place survives removing any one judge in <strong>${c.winner_holds} of ${c.refits}</strong> refits; the top three survive in ${c.podium_holds} of ${c.refits}. One review's noise is about ${c.sigma.toFixed(2)} points (σ). Intervals come from ${c.replicates} seeded simulations (seed ${c.seed}).</p>
<p>${c.prize_line.map((s) => `Places ${s.place} and ${s.place + 1}: ${s.order_share >= 0.9 ? 'separated' : 'a statistical tie'} (order kept in ${Math.round(s.order_share * 100)}% of simulations).`).join(' ')}</p>` : '<p class="muted">No uncertainty analysis in this snapshot.</p>'}
<h2>Method</h2>
<dl>
<dt>Model</dt><dd><code>${e(doc.method.name)}</code>, λ = ${doc.method.lambda}, scale ${doc.event.scale.join('–')}</dd>
<dt>Weights</dt><dd>${Object.entries(doc.method.weights).map(([k, w]) => `${e(k)} ${w}`).join(', ')}</dd>
<dt>Fixed before scoring</dt><dd>${commitment ? `${e(commitment.committed_at)}, fingerprint <code>${e(commitment.fingerprint.slice(0, 16))}…</code>: ${commitment.unchanged ? 'unchanged at publication' : `<span class="bad">changed after scoring began</span> (${commitment.later_rubric_edits} rubric edit(s) on the audit trail)`}` : 'not recorded'}</dd>
<dt>Audit anchor</dt><dd>${doc.audit_anchor ? `entry #${doc.audit_anchor.id}, <code>${e(doc.audit_anchor.hash)}</code>` : 'none'}</dd>
<dt>Public key</dt><dd><code>${e(evidence.publicKey)}</code></dd>
<dt>Signature</dt><dd><code>${e(evidence.signature)}</code></dd>
</dl>
<p class="muted">Judges appear as J01, J02… The organizer's database maps them to people; this file does not.</p>
</main>
<script type="application/json" id="doc-text">${json(evidence.documentText)}</script>
<script type="application/json" id="signature">${json(evidence.signature)}</script>
<script type="application/json" id="public-key">${json(evidence.publicKey)}</script>
<script type="application/json" id="inputs">${json(evidence.inputs)}</script>
<script>
(async () => {
  const read = (id) => JSON.parse(document.getElementById(id).textContent);
  const text = read('doc-text'), signature = read('signature'), publicKey = read('public-key'), inputs = read('inputs');
  const doc = JSON.parse(text);
  const show = (id, ok, label, detail) => { const li = document.getElementById(id); li.innerHTML = ''; const b = document.createElement('span'); b.className = ok ? 'ok' : 'bad'; b.textContent = (ok ? '✓ ' : '✗ ') + label; li.append(b, document.createTextNode(': ' + detail)); };
  const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (!globalThis.crypto || !crypto.subtle) {
    show('c-sig', false, 'Signature', 'could not be checked: this browser has no WebCrypto here. Open the file in a current Chrome, Firefox or Safari.');
  } else {
    try {
      const key = await crypto.subtle.importKey('raw', b64u(publicKey), { name: 'Ed25519' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64u(signature), new TextEncoder().encode(text));
      show('c-sig', ok, 'Signature', ok ? 'matches the results document: nothing in it changed after the portal signed it.' : 'does NOT match: the document was changed after signing.');
    } catch (err) {
      show('c-sig', false, 'Signature', 'could not be checked (' + err.message + '). Ed25519 needs Chrome 137+, Firefox 129+ or Safari 17+.');
    }
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(inputs))));
    const fpOk = digest === doc.inputs.fingerprint;
    show('c-fp', fpOk, 'Inputs fingerprint', fpOk ? 'the ' + inputs.length + ' embedded reviews are exactly the ones the signed document describes.' : 'does NOT match the signed document.');
  }
  // The same fit as the portal: x = mu + a_p + b_j, ridge penalty lambda on b_j, exact block updates.
  const lambda = doc.method.lambda, byP = new Map(), byJ = new Map();
  const obs = inputs.map(([judge, project, score]) => ({ judge, project, score }));
  for (const o of obs) { (byP.get(o.project) || byP.set(o.project, []).get(o.project)).push(o); (byJ.get(o.judge) || byJ.set(o.judge, []).get(o.judge)).push(o); }
  const P = [...byP.keys()].sort(), J = [...byJ.keys()].sort();
  const mu = obs.reduce((s, o) => s + o.score, 0) / obs.length;
  const a = new Map(P.map((p) => [p, 0])), bj = new Map(J.map((j) => [j, 0]));
  for (let it = 0, change = 1; change >= 1e-12 && it < 10000; it++) {
    change = 0;
    for (const p of P) { const r = byP.get(p); const v = r.reduce((s, o) => s + (o.score - mu - bj.get(o.judge)), 0) / r.length; change = Math.max(change, Math.abs(v - a.get(p))); a.set(p, v); }
    for (const j of J) { const r = byJ.get(j); const v = r.reduce((s, o) => s + (o.score - mu - a.get(o.project)), 0) / (r.length + lambda); change = Math.max(change, Math.abs(v - bj.get(j))); bj.set(j, v); }
  }
  const scores = new Map(P.map((p) => [p, mu + a.get(p)])), values = [...scores.values()];
  const bad = doc.ranking.filter((r) => { const s = scores.get(r.project); return s === undefined || Math.abs(s - r.score) > 1e-6 || 1 + values.filter((w) => w > s + 1e-9).length !== r.rank; });
  const fitOk = bad.length === 0 && scores.size === doc.ranking.length;
  show('c-fit', fitOk, 'Refit of the ranking', fitOk ? 'refitting the ' + obs.length + ' reviews with ' + doc.method.name + ' (λ = ' + lambda + ') gives every published score and rank.' : 'differs for ' + (bad.map((r) => r.title).join(', ') || 'the project count') + '.');
})();
</script>
</body>
</html>
`;
}
