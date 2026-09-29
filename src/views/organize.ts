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

export interface OverviewView {
  event: EventRow;
  progress: Progress;
  flags: { judge: string; name: string; flags: JudgeFlag[] }[];
  duplicates: number;
  rubricReady: boolean;
}

export function overviewPage(ctx: Ctx, view: OverviewView): SafeHtml {
  const { event } = view;
  const phase = phaseOf(event, ctx.now);
  const steps: [boolean, Renderable][] = [
    [true, html`Event created, deadline ${when(event.submissions_close_at, ctx.now)}`],
    [view.rubricReady, html`<a href="/organize/${event.slug}/rubric">Rubric</a> has criteria and weights`],
    [view.progress.judges.length > 0, html`<a href="/organize/${event.slug}/judges">Judges invited</a> (${view.progress.judges.length})`],
    [phase.key !== 'open' && phase.key !== 'upcoming', 'Submissions closed'],
    [view.progress.reviews.assigned > 0, html`<a href="/organize/${event.slug}/assignments">Projects assigned</a> (${view.progress.reviews.assigned} review slots)`],
    [view.progress.coverage.atTarget === view.progress.projects.submitted && view.progress.projects.submitted > 0, `Every project has ${event.reviews_per_project} reviews`],
    [Boolean(event.results_published_at), html`<a href="/organize/${event.slug}/results">Results published</a>`],
  ];
  return organizerPage(ctx, event, '', 'Overview', html`
<div class="two-col wide-left">
  <div data-live="/organize/${event.slug}/progress" data-interval="10" aria-live="polite">${progressFragment(ctx, view)}</div>
  <aside>
    ${section('Next steps', html`<ol class="checklist">${steps.map(([done, label]) => html`<li class="${cx(done && 'done')}"><span class="tick" aria-hidden="true">${done ? '✓' : ''}</span><span>${label}</span><span class="sr-only">${done ? '(done)' : '(to do)'}</span></li>`)}</ol>`)}
    ${phase.key === 'open' ? confirmForm(ctx, `/organize/${event.slug}/close-submissions`, 'Close submissions now', 'Moves the deadline to this moment. Every team’s project is frozen as it is, and judging can begin.', 'Yes, close now', 'danger') : ''}
  </aside>
</div>`, { lead: 'Live: this page refreshes itself every 10 seconds.' });
}

const FLAG_LABELS: Record<JudgeFlag, string> = {
  'identical-scores': 'identical scores',
  'same-total': 'same total',
  'few-reviews': 'few reviews',
  harsh: 'harsh',
  generous: 'generous',
};

export function flagPills(flags: JudgeFlag[]): SafeHtml {
  return html`${flags.map((f) => pill(FLAG_LABELS[f], f === 'identical-scores' ? 'danger' : f === 'same-total' ? 'warn' : f === 'few-reviews' ? 'neutral' : 'warn'))}`;
}

export function progressFragment(ctx: Ctx, view: OverviewView): SafeHtml {
  const { progress: p, event } = view;
  const reviewPct = p.reviews.assigned ? Math.round((p.reviews.submitted / p.reviews.assigned) * 100) : 0;
  const flagged = new Map(view.flags.map((f) => [f.judge, f.flags]));
  return html`
<div class="stat-row">
  ${stat('Submitted projects', String(p.projects.submitted), `${p.projects.drafts} drafts · ${p.projects.withdrawn} withdrawn · ${p.projects.replaced} replaced`)}
  ${stat('Reviews submitted', `${p.reviews.submitted} / ${p.reviews.assigned}`, `${reviewPct}% · ${p.reviews.drafts} in draft · ${p.reviews.notStarted} not started`)}
  ${stat('At target coverage', `${p.coverage.atTarget} / ${p.projects.submitted}`, `${event.reviews_per_project} reviews each · ${p.coverage.below} below · ${p.coverage.none} with none`)}
  ${stat('Judges', String(p.judges.length), `${p.judges.filter((j) => j.submitted > 0).length} have submitted`)}
</div>
${meter(p.reviews.submitted, p.reviews.assigned, `${p.reviews.submitted} of ${p.reviews.assigned} reviews submitted`)}
${view.duplicates ? notice('warn', html`${view.duplicates} team(s) submitted more than once. The latest submission counts; <a href="/organize/${event.slug}/projects#duplicates">review the decision</a>.`, 'Duplicates.') : ''}
${section('Coverage by track', html`<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Track</th><th scope="col" class="n">Projects</th><th scope="col" class="n">At target</th><th scope="col" class="n">Reviews</th><th scope="col" class="n">Judges</th></tr></thead>
  <tbody>${p.tracks.map((t) => html`<tr><td>${t.name}</td><td class="n">${t.projects}</td><td class="n">${t.atTarget}${t.atTarget < t.projects ? html` ${pill(`${t.projects - t.atTarget} short`, 'warn')}` : ''}</td><td class="n">${t.reviews}</td><td class="n">${t.judges}</td></tr>`)}</tbody>
</table></div>
<p class="hint">Reviews per project: ${p.coverage.histogram.map((h) => `${h.projects} with ${h.reviews}`).join(' · ') || 'none yet'}.</p>`)}
${section('Judges', p.judges.length === 0 ? empty('No judges yet', html`<a href="/organize/${event.slug}/judges">Invite judges</a> to start.`) : html`<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Judge</th><th scope="col" class="n">Submitted</th><th scope="col" class="n">Draft</th><th scope="col" class="n">Assigned</th><th scope="col">Progress</th><th scope="col">Last activity</th><th scope="col">Flags</th></tr></thead>
  <tbody>${p.judges.map((j) => html`<tr>
    <td>${j.name}${j.invited && !j.accepted_at && !j.has_password ? html` ${pill('invited', 'info')}` : ''}</td>
    <td class="n">${j.submitted}</td><td class="n">${j.drafts}</td><td class="n">${j.assigned}</td>
    <td>${meter(j.submitted, j.assigned, `${j.name}: ${j.submitted} of ${j.assigned}`)}</td>
    <td>${j.last_activity ? html`<time datetime="${j.last_activity}" title="${formatUtc(j.last_activity)}">${relative(j.last_activity, ctx.now)}</time>` : html`<span class="muted">${j.submitted ? 'imported' : '–'}</span>`}</td>
    <td>${flagPills(flagged.get(j.id) ?? [])}</td></tr>`)}</tbody>
</table></div>`, { lead: '“Identical scores”: every criterion of every review was the same. “Same total”: criteria varied but every weighted total was equal. Either way the judge does not separate their projects.' })}
${section('Recent activity', p.recent.length ? auditList(ctx, p.recent) : html`<p class="muted">Nothing yet.</p>`, { actions: linkButton(`/organize/${event.slug}/audit`, 'Full audit trail', 'ghost', true) })}`;
}

// Settings -------------------------------------------------------------------------------

export interface SettingsView {
  event: EventRow;
  tracks: (TrackRow & { projects: number })[];
  prizes: (PrizeRow & { track_name: string | null })[];
  organizers: { id: string; name: string; email: string }[];
  values?: Record<string, string>;
  errors?: Record<string, string>;
}

