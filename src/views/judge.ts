import { judgingOpen, phaseOf } from '../domain/events.ts';
import type { QueueItem, ReviewPage } from '../domain/judging.ts';
import type { EventRow, UserRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { formatUtc } from '../util/time.ts';
import { button, csrf, empty, formErrors, linkButton, meter, notice, pageHeader, pill, section, textarea, when } from './components.ts';
import { cx, html, raw, type SafeHtml } from './html.ts';
import { page } from './layout.ts';
import { phasePill } from './public.ts';

export function judgeHomePage(ctx: Ctx, events: (EventRow & { total: number; submitted: number })[]): SafeHtml {
  return page(ctx, {
    title: 'Judging',
    nav: 'judge',
    body: html`
${pageHeader('Judging', { lead: 'Events you judge. You only ever see your own assignments and your own scores.' })}
${events.length === 0 ? empty('Nothing to judge', 'An organizer has not invited you to judge an event.') : html`<ul class="event-list">${events.map((e) => html`<li class="card">
  <div class="card-top">${phasePill(phaseOf(e, ctx.now))}</div>
  <h2 class="card-title"><a href="/judge/${e.slug}">${e.name}</a></h2>
  <p class="card-meta">${e.submitted} of ${e.total} reviews submitted</p>
  ${meter(e.submitted, e.total, `${e.submitted} of ${e.total} reviews submitted`)}
</li>`)}</ul>`}`,
  });
}

const statusPill = (item: QueueItem) =>
  item.replaced ? pill('withdrawn or replaced', 'neutral') : item.review_status === 'submitted' ? pill('submitted', 'success') : item.review_status === 'draft' ? pill('draft', 'warn') : pill('to do', 'info');

export function queuePage(ctx: Ctx, event: EventRow, items: QueueItem[]): SafeHtml {
  const done = items.filter((i) => i.review_status === 'submitted').length;
  const open = judgingOpen(event, ctx.now);
  const next = items.find((i) => i.review_status !== 'submitted' && !i.replaced);
  return page(ctx, {
    title: `Judging ${event.name}`,
    nav: 'judge',
    body: html`
${pageHeader('Your judging queue', {
  eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>`,
  lead: `${done} of ${items.length} submitted. Scores use a ${event.score_min}–${event.score_max} scale. Other judges’ scores are never shown to you.`,
  actions: next && open ? linkButton(`/judge/reviews/${next.assignment_id}`, done === 0 ? 'Start judging' : 'Next unfinished', 'primary') : '',
})}
${meter(done, items.length, `${done} of ${items.length} reviews submitted`)}
${phaseOf(event, ctx.now).key === 'open' ? notice('info', html`Judging opens when submissions close, ${when(event.submissions_close_at, ctx.now)}. You can read your assignments now.`) : ''}
${!open && phaseOf(event, ctx.now).key !== 'open' ? notice('info', 'Judging has closed. Your reviews are shown read-only.') : ''}
${items.length === 0
  ? empty('No assignments yet', 'The organizer has not assigned projects to you. They appear here as soon as they do.')
  : html`<div class="table-wrap"><table class="data">
  <caption class="sr-only">Your assignments</caption>
  <thead><tr><th scope="col">Project</th><th scope="col">Track</th><th scope="col">Team</th><th scope="col">Status</th><th scope="col">Last saved</th></tr></thead>
  <tbody>${items.map((i) => html`<tr>
    <td><a href="/judge/reviews/${i.assignment_id}">${i.title}</a></td>
    <td>${i.track_name ?? ''}</td><td>${i.team_name}</td><td>${statusPill(i)}</td>
    <td>${i.updated_at ? when(i.updated_at, ctx.now) : html`<span class="muted">–</span>`}</td></tr>`)}</tbody>
</table></div>`}`,
  });
}

export function reviewFormPage(ctx: Ctx, view: ReviewPage, options: { errors?: Record<string, string>; values?: Record<string, string>; nextId?: string | null } = {}): SafeHtml {
  const { project, event, criteria } = view;
  const errors = options.errors ?? {};
  const valueOf = (key: string, id: string) => options.values?.[`score_${key}`] ?? (view.scores.has(id) ? String(view.scores.get(id)) : '');
  const scale = Array.from({ length: event.score_max - event.score_min + 1 }, (_, i) => event.score_min + i);
  const links = [['Repository', project.repo_url], ['Demo', project.demo_url], ['Video', project.video_url]].filter(([, url]) => url);
  const readOnlyReason = !view.isOwn
    ? 'You are viewing this review as an organizer. Only the assigned judge can change it.'
    : project.status !== 'submitted' || project.superseded_by
      ? 'This project was withdrawn or replaced, so it no longer takes reviews.'
      : !view.canEdit
        ? phaseOf(event, ctx.now).key === 'open'
          ? `Judging opens when submissions close, ${formatUtc(event.submissions_close_at)}.`
          : 'Judging has closed, so this review is final.'
        : null;

  return page(ctx, {
    title: `Review: ${project.title}`,
    nav: view.isOwn ? 'judge' : 'organize',
    wide: true,
    body: html`
${pageHeader(project.title, {
  eyebrow: html`<a href="${view.isOwn ? `/judge/${event.slug}` : `/organize/${event.slug}/assignments`}">${view.isOwn ? 'Your queue' : 'Assignments'}</a> · ${project.track_name ?? event.name}`,
  lead: project.summary,
})}
<div class="review-layout">
  <article class="review-project">
    ${section('Project', html`
      <dl class="facts">
        <div><dt>Team</dt><dd>${project.team_name}</dd></div>
        <div><dt>Track</dt><dd>${project.track_name ?? '–'}</dd></div>
        <div><dt>Submitted</dt><dd>${when(project.submitted_at, ctx.now)}</dd></div>
      </dl>
      ${project.description ? html`<div class="prose">${project.description}</div>` : html`<p class="muted">No description was given.</p>`}
      ${links.length ? html`<ul class="link-list">${links.map(([label, url]) => html`<li><span>${label}</span> <a href="${url}" rel="nofollow noopener ugc">${url}</a></li>`)}</ul>` : ''}`)}
  </article>
  <aside class="review-ballot">
    ${raw(readOnlyReason ? '<div class="panel ballot">' : '')}${readOnlyReason ? '' : html`<form method="post" action="/judge/reviews/${view.assignment.id}" class="panel ballot" novalidate>`}
      <div class="panel-head"><h2>Your scores</h2>${view.review ? pill(view.review.status, view.review.status === 'submitted' ? 'success' : 'warn') : pill('not started', 'info')}</div>
      ${readOnlyReason ? notice('info', readOnlyReason) : ''}
      ${formErrors(errors)}
      ${readOnlyReason ? '' : csrf(ctx)}
      ${criteria.map((c) => {
        const current = valueOf(c.key, c.id);
        const error = errors[`score_${c.key}`];
        return html`<fieldset class="${cx('criterion', error && 'has-error')}"${readOnlyReason ? html` disabled` : ''}>
          <legend>${c.name} <span class="weight">weight ${formatWeight(c.weight, criteria)}</span></legend>
          ${c.description ? html`<p class="hint">${c.description}</p>` : ''}
          <div class="scale" role="radiogroup" aria-label="${c.name}">
            ${scale.map((n) => html`<label class="scale-option"><input type="radio" name="score_${c.key}" value="${n}"${String(n) === current ? html` checked` : ''}><span aria-hidden="true">${n}</span><span class="sr-only">${c.name}: ${n} out of ${event.score_max}</span></label>`)}
          </div>
          <p class="scale-ends"><span>${event.score_min}: weak</span><span>${event.score_max}: outstanding</span></p>
          ${error ? html`<p class="error-text">${error}</p>` : ''}
        </fieldset>`;
      })}
      ${readOnlyReason
        ? html`<div class="field"><p class="label">Comment</p><div class="prose">${view.review?.comment || html`<span class="muted">No comment.</span>`}</div></div>`
        : textarea({ name: 'comment', label: 'Comment for the organizers', value: options.values?.comment ?? view.review?.comment ?? '', rows: 5, maxlength: 5000, hint: 'Optional. Organizers can read it; other judges cannot.' })}
      ${readOnlyReason ? '' : html`<div class="form-actions">
        ${view.review?.status === 'submitted' ? button('Save changes', { name: 'intent', value: 'submit' }) : html`${button('Save draft', { variant: 'secondary', name: 'intent', value: 'draft' })} ${button('Submit review', { name: 'intent', value: 'submit' })}`}
      </div>
      <p class="hint">A submitted review can still be revised until judging closes. Every change is on the audit trail.</p>`}
    ${raw(readOnlyReason ? '</div>' : '</form>')}
  </aside>
</div>`,
  });
}

function formatWeight(weight: number, criteria: { weight: number }[]): string {
  const total = criteria.reduce((sum, c) => sum + c.weight, 0);
  return total > 0 ? `${Math.round((weight / total) * 100)}%` : '';
}

export function judgeInviteAcceptPage(ctx: Ctx, event: EventRow, invited: UserRow): SafeHtml {
  const signedInAsInvitee = ctx.user?.id === invited.id;
  return page(ctx, {
    title: `Judge ${event.name}`,
    body: html`<div class="auth-card">
  <p class="eyebrow">Invitation to judge</p>
  <h1>${event.name}</h1>
  <p>This invitation is for <strong>${invited.email}</strong>.</p>
  ${signedInAsInvitee
    ? html`<form method="post" action="${ctx.url.pathname}">${csrf(ctx)}${button('Accept and open my queue')}</form>`
    : ctx.user
      ? notice('warn', html`You are signed in as ${ctx.user.email}. Sign out, then sign in as ${invited.email} to accept.`)
      : html`<p>${linkButton(`/login?next=${encodeURIComponent(ctx.url.pathname)}`, `Sign in as ${invited.email}`, 'primary')}</p>`}
</div>`,
  });
}
