import type { AuditRow } from '../domain/audit.ts';
import { phaseOf } from '../domain/events.ts';
import { EXPORT_DESCRIPTIONS, EXPORT_KINDS } from '../domain/exports.ts';
import type { AssignmentView } from '../domain/judging.ts';
import type { Progress } from '../domain/progress.ts';
import type { TeamSubmissions } from '../domain/projects.ts';
import type { JudgeFlag, Snapshot, Standings } from '../domain/results.ts';
import type { CriterionRow, EventRow, PrizeRow, ProjectRow, TrackRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { formatUtc, relative, toDatetimeLocal } from '../util/time.ts';
import { actionForm, button, checkboxes, confirmForm, csrf, empty, formErrors, input, linkButton, meter, notice, num, pageHeader, pill, section, select, signed, stat, textarea, when } from './components.ts';
import { cx, html, type Renderable, type SafeHtml } from './html.ts';
import { organizerTabs, page } from './layout.ts';
import { phasePill } from './public.ts';

function organizerPage(ctx: Ctx, event: EventRow, tab: string, title: string, body: Renderable, options: { lead?: Renderable; actions?: Renderable } = {}): SafeHtml {
  return page(ctx, {
    title: `${title} · ${event.name}`,
    nav: 'organize',
    wide: true,
    body: html`
${pageHeader(title, { eyebrow: html`<a href="/events/${event.slug}">${event.name}</a> ${phasePill(phaseOf(event, ctx.now))}`, lead: options.lead, actions: options.actions })}
${organizerTabs(event, tab)}
${body}`,
  });
}

export function organizeHomePage(ctx: Ctx, events: EventRow[]): SafeHtml {
  return page(ctx, {
    title: 'Organize',
    nav: 'organize',
    body: html`
${pageHeader('Events you organize', { actions: ctx.user?.is_admin ? linkButton('/events/new', 'Create an event', 'primary') : '' })}
${events.length === 0 ? empty('No events', 'You do not organize any event yet.') : html`<ul class="event-list">${events.map((e) => html`<li class="card">
  <div class="card-top">${phasePill(phaseOf(e, ctx.now))}</div>
  <h2 class="card-title"><a href="/organize/${e.slug}">${e.name}</a></h2>
  <p class="card-meta">Deadline ${when(e.submissions_close_at, ctx.now)}</p>
</li>`)}</ul>`}`,
  });
}

// Event form (create and settings) ---------------------------------------------------------

export function eventFields(values: Record<string, string>, errors: Record<string, string> = {}, creating = false): SafeHtml {
  return html`
  ${input({ name: 'name', label: 'Event name', value: values.name, required: true, maxlength: 120, error: errors.name })}
  ${input({ name: 'tagline', label: 'Tagline', value: values.tagline, maxlength: 200, error: errors.tagline })}
  ${textarea({ name: 'description', label: 'Description', value: values.description, rows: 4, maxlength: 5000, error: errors.description })}
  <div class="grid-3">
    ${input({ name: 'submissions_open_at', label: 'Submissions open (UTC)', type: 'datetime-local', value: values.submissions_open_at, error: errors.submissions_open_at, hint: 'Leave empty to open now.' })}
    ${input({ name: 'submissions_close_at', label: 'Submission deadline (UTC)', type: 'datetime-local', value: values.submissions_close_at, required: true, error: errors.submissions_close_at })}
    ${input({ name: 'judging_close_at', label: 'Judging closes (UTC)', type: 'datetime-local', value: values.judging_close_at, error: errors.judging_close_at, hint: 'Empty: when results are published.' })}
  </div>
  <div class="grid-3">
    ${input({ name: 'max_team_size', label: 'Maximum team size', type: 'number', min: 1, max: 20, value: values.max_team_size, error: errors.max_team_size })}
    ${input({ name: 'reviews_per_project', label: 'Reviews per project', type: 'number', min: 1, max: 20, value: values.reviews_per_project, error: errors.reviews_per_project, hint: 'Target used by auto-assignment.' })}
  </div>
  ${creating ? textarea({ name: 'tracks', label: 'Tracks', value: values.tracks, rows: 4, error: errors.tracks, hint: 'One per line. You can add more later.' }) : ''}`;
}

export function eventFormPage(ctx: Ctx, view: { values: Record<string, string>; errors?: Record<string, string> }): SafeHtml {
  return page(ctx, {
    title: 'Create an event',
    nav: 'organize',
    body: html`
${pageHeader('Create an event', { lead: 'You become its first organizer. The rubric starts with three equally weighted criteria that you can change before judging starts.' })}
${formErrors(view.errors)}
<form method="post" action="/events/new" class="form-card" novalidate>
  ${csrf(ctx)}
  ${eventFields(view.values, view.errors, true)}
  <div class="form-actions">${button('Create event')} <a class="btn btn-ghost" href="/events">Cancel</a></div>
</form>`,
  });
}

// Overview (live) ---------------------------------------------------------------------------

