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

