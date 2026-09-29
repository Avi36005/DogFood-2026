import type { CompareProject, CompareView, PairwiseSummary } from '../domain/compare.ts';
import type { Ctx } from '../http/context.ts';
import { button, csrf, empty, notice, pageHeader, section } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';

function side(ctx: Ctx, view: CompareView, project: CompareProject, other: CompareProject, label: string): SafeHtml {
  const links = [['Repository', project.repo_url], ['Demo', project.demo_url], ['Video', project.video_url]].filter(([, url]) => url);
  return html`<article class="compare-side">
  <p class="eyebrow">${label}</p>
  <h2>${project.title}</h2>
  <p class="muted">${project.team_name}${project.track_name ? ` · ${project.track_name}` : ''}</p>
  <p>${project.summary}</p>
  ${links.length ? html`<ul class="link-list">${links.map(([name, url]) => html`<li><span>${name}</span> <a href="${url}" rel="nofollow noopener ugc">${url}</a></li>`)}</ul>` : ''}
  <p><a href="/projects/${project.id}">Full project page</a></p>
  ${view.open ? html`<form method="post" action="/judge/${view.event.slug}/compare">${csrf(ctx)}<input type="hidden" name="winner" value="${project.id}"><input type="hidden" name="loser" value="${other.id}">${button(html`${project.title} is better`)}</form>` : ''}
</article>`;
}

export function comparePage(ctx: Ctx, view: CompareView): SafeHtml {
  const [a, b] = view.pair ?? [];
  return page(ctx, {
    title: `Compare · ${view.event.name}`,
    nav: 'judge',
    body: html`
${pageHeader('Compare mode', {
  eyebrow: html`<a href="/judge/${view.event.slug}">Your judging queue</a>`,
  lead: `Two of your assigned projects: which is better overall? ${view.made} of ${view.possible} pairs compared. Choices are final and never shown to other judges.`,
})}
${!view.open ? notice('info', 'Judging is closed, so compare mode is read-only.') : ''}
${a && b
  ? html`<div class="compare">${side(ctx, view, a, b, 'Project A')}${side(ctx, view, b, a, 'Project B')}</div>
<p class="hint">Your choices feed a Bradley–Terry ranking the organizers see beside the rubric ranking, as a second opinion. They never change your rubric scores.</p>`
  : empty(view.possible === 0 ? 'Nothing to compare' : 'All pairs compared', view.possible === 0 ? 'Compare mode needs at least two assigned projects.' : 'You have compared every pair of your assigned projects. Thank you.')}`,
  });
}

export function pairwiseSection(summary: PairwiseSummary | null): SafeHtml {
  if (!summary) return html``;
  const top = summary.order.slice(0, 10);
  return section('Second opinion: pairwise (Bradley–Terry)', html`
<p>${summary.implied} comparisons implied by judges' own scores${summary.explicit ? `, plus ${summary.explicit} made in compare mode` : ''}. Rank agreement with the rubric ranking: <strong>ρ = ${summary.agreement.rho.toFixed(2)}</strong> over ${summary.agreement.n} projects. ${summary.sameWinner ? 'Both put the same project first.' : html`<strong>They disagree about first place</strong>: look at the certainty section before publishing.`}</p>
<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Pairwise</th><th scope="col">Project</th><th scope="col" class="n">Won</th><th scope="col" class="n">Lost</th><th scope="col" class="n">Strength (log)</th><th scope="col" class="n">Rubric rank</th></tr></thead>
  <tbody>${top.map((r, i) => html`<tr><td class="rank">${i + 1}</td><td><a href="/projects/${r.project_id}">${r.title}</a></td><td class="n">${r.wins}</td><td class="n">${r.losses}</td><td class="n">${r.theta.toFixed(2)}</td><td class="n">${r.rubricRank ?? '–'}</td></tr>`)}</tbody>
</table></div>`,
  { lead: html`A comparison is made inside one judge's scale, so leniency cancels out; a judge who scores everything the same adds nothing. The rubric ranking stays the result. See <a href="/about#normalization">the method</a>.` });
}
