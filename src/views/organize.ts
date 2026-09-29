import type { AuditRow, ChainReport } from '../domain/audit.ts';
import type { CommitmentStatus } from '../domain/commitment.ts';
import type { PairwiseSummary } from '../domain/compare.ts';
import { pairwiseSection } from './compare.ts';
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

export function organizerPage(ctx: Ctx, event: EventRow, tab: string, title: string, body: Renderable, options: { lead?: Renderable; actions?: Renderable } = {}): SafeHtml {
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

export function settingsPage(ctx: Ctx, view: SettingsView): SafeHtml {
  const { event } = view;
  const values = view.values ?? {
    name: event.name,
    tagline: event.tagline,
    description: event.description,
    submissions_open_at: toDatetimeLocal(event.submissions_open_at),
    submissions_close_at: toDatetimeLocal(event.submissions_close_at),
    judging_close_at: toDatetimeLocal(event.judging_close_at),
    max_team_size: String(event.max_team_size),
    reviews_per_project: String(event.reviews_per_project),
  };
  return organizerPage(ctx, event, 'settings', 'Event settings', html`
<div class="two-col wide-left">
  <div>
    ${section('Details and dates', html`${formErrors(view.errors)}
      <form method="post" action="/organize/${event.slug}/settings" novalidate>${csrf(ctx)}${eventFields(values, view.errors)}
      <p class="hint">All times are UTC. Moving the deadline is audited; the server enforces whatever is saved here.</p>
      <div class="form-actions">${button('Save settings')}</div></form>`)}
  </div>
  <aside>
    ${section('Tracks', html`<ul class="row-list">${view.tracks.map((t) => html`<li><span>${t.name}</span>${t.projects ? html`<span class="muted small">${t.projects} project${t.projects === 1 ? '' : 's'}</span>` : actionForm(ctx, `/organize/${event.slug}/tracks/${t.id}/remove`, 'Remove', { small: true, variant: 'ghost' })}</li>`)}</ul>
      <form method="post" action="/organize/${event.slug}/tracks" class="inline-add">${csrf(ctx)}${input({ name: 'name', id: 'track-name', label: 'New track', maxlength: 80 })}${button('Add track', { variant: 'secondary', small: true })}</form>`)}
    ${section('Prizes', html`${view.prizes.length ? html`<ul class="row-list">${view.prizes.map((p) => html`<li><span><strong>${p.name}</strong> <span class="muted">${p.track_name ?? 'overall'}</span></span>${actionForm(ctx, `/organize/${event.slug}/prizes/${p.id}/remove`, 'Remove', { small: true, variant: 'ghost' })}</li>`)}</ul>` : html`<p class="muted">No prizes yet.</p>`}
      <form method="post" action="/organize/${event.slug}/prizes" class="stack-form">${csrf(ctx)}
        ${input({ name: 'name', id: 'prize-name', label: 'Prize name', maxlength: 120 })}
        ${select({ name: 'track_id', id: 'prize-track', label: 'For track', blank: 'Overall', options: view.tracks.map((t) => ({ value: t.id, label: t.name })) })}
        ${input({ name: 'description', id: 'prize-description', label: 'Description', maxlength: 1000 })}
        ${button('Add prize', { variant: 'secondary', small: true })}</form>`)}
    ${section('Organizers', html`<ul class="plain-list">${view.organizers.map((o) => html`<li>${o.name} <span class="muted">${o.email}</span></li>`)}</ul>
      <form method="post" action="/organize/${event.slug}/organizers" class="inline-add">${csrf(ctx)}${input({ name: 'email', id: 'organizer-email', label: 'Add organizer by email', type: 'email' })}${button('Add', { variant: 'secondary', small: true })}</form>
      <p class="hint">Organizers can read every score, so a judge of this event cannot be added.</p>`)}
  </aside>
</div>`);
}

// Rubric -----------------------------------------------------------------------------------

export function rubricPage(ctx: Ctx, event: EventRow, criteria: CriterionRow[], locked: boolean, errors?: Record<string, string>): SafeHtml {
  const total = criteria.reduce((sum, c) => sum + c.weight, 0);
  return organizerPage(ctx, event, 'rubric', 'Rubric', html`
${locked ? notice('info', 'Scoring has started, so criteria and the scale are fixed. You can still rename criteria and change weights; the ranking is recomputed from the stored raw scores, and every change is on the audit trail.', 'Criteria locked.') : ''}
${formErrors(errors)}
<form method="post" action="/organize/${event.slug}/rubric" class="panel" novalidate>
  ${csrf(ctx)}
  <div class="table-wrap"><table class="data rubric-table">
    <thead><tr><th scope="col">Criterion</th><th scope="col">Description</th><th scope="col" class="n">Weight</th><th scope="col" class="n">Share</th>${locked ? '' : html`<th scope="col">Remove</th>`}</tr></thead>
    <tbody>${criteria.map((c) => html`<tr>
      <td><label class="sr-only" for="name_${c.id}">Name of ${c.name}</label><input id="name_${c.id}" name="name_${c.id}" value="${c.name}" maxlength="80" required> <code class="muted">${c.key}</code></td>
      <td><label class="sr-only" for="description_${c.id}">Description of ${c.name}</label><input id="description_${c.id}" name="description_${c.id}" value="${c.description}" maxlength="500"></td>
      <td class="n"><label class="sr-only" for="weight_${c.id}">Weight of ${c.name}</label><input class="num-input" id="weight_${c.id}" name="weight_${c.id}" type="number" min="0.1" max="100" step="0.1" value="${c.weight}" required></td>
      <td class="n">${total ? `${Math.round((c.weight / total) * 100)}%` : ''}</td>
      ${locked ? '' : html`<td><label class="check"><input type="checkbox" name="remove_${c.id}"> <span class="sr-only">Remove ${c.name}</span></label></td>`}
    </tr>`)}</tbody>
  </table></div>
  ${locked ? '' : html`<fieldset class="add-row"><legend>Add a criterion</legend><div class="grid-3">
    ${input({ name: 'new_name', label: 'Name', maxlength: 80 })}${input({ name: 'new_description', label: 'Description', maxlength: 500 })}${input({ name: 'new_weight', label: 'Weight', type: 'number', min: 0.1, max: 100, step: '0.1', value: '1' })}
  </div></fieldset>
  <div class="grid-3">${input({ name: 'score_min', label: 'Lowest score', type: 'number', min: 0, max: 10, value: event.score_min })}${input({ name: 'score_max', label: 'Highest score', type: 'number', min: 1, max: 100, value: event.score_max, error: errors?.score_max })}</div>`}
  ${locked ? html`<input type="hidden" name="score_min" value="${event.score_min}"><input type="hidden" name="score_max" value="${event.score_max}">` : ''}
  <p class="hint">Weights are relative: 2, 1, 1 means the first criterion counts for half. A review’s score is the weighted mean of its criteria, on the ${event.score_min}–${event.score_max} scale.</p>
  <div class="form-actions">${button('Save rubric')}</div>
</form>`, { lead: 'What judges score, and how much each part counts.' });
}

// Judges ------------------------------------------------------------------------------------

export interface JudgesView {
  event: EventRow;
  judges: Progress['judges'];
  tracks: TrackRow[];
  inviteLink?: { email: string; url: string } | null;
  errors?: Record<string, string>;
  values?: Record<string, string | string[]>;
}

export function judgesPage(ctx: Ctx, view: JudgesView): SafeHtml {
  const { event, tracks } = view;
  const trackName = new Map(tracks.map((t) => [t.id, t.name]));
  const trackOptions = tracks.map((t) => ({ value: t.id, label: t.name }));
  const chosen = view.values?.track_ids;
  return organizerPage(ctx, event, 'judges', 'Judges', html`
${view.inviteLink ? notice('success', html`Send this one-time link to ${view.inviteLink.email}. There is no mail server, so Forgeboard does not send it for you. Only a fingerprint is stored, so copy it now.
  <span class="copy-row"><input class="copy-field" type="text" readonly value="${view.inviteLink.url}" id="judge-link" aria-label="Judge invite link"><button type="button" class="btn btn-secondary btn-sm" data-copy="judge-link">Copy</button></span>`, 'Judge invited.') : ''}
<div class="two-col wide-left">
  <div>
    ${view.judges.length === 0 ? empty('No judges yet', 'Invite the first one with the form.') : html`<div class="table-wrap"><table class="data">
      <thead><tr><th scope="col">Judge</th><th scope="col">Tracks</th><th scope="col" class="n">Done</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${view.judges.map((j) => html`<tr>
        <td><strong>${j.name}</strong><br><span class="muted">${j.email}</span> <code class="muted">${j.id}</code></td>
        <td><details class="inline-details"><summary>${j.trackIds.length ? j.trackIds.map((id) => trackName.get(id) ?? id).join(', ') : 'All tracks'}</summary>
          <form method="post" action="/organize/${event.slug}/judges/${j.id}/tracks" class="stack-form">${csrf(ctx)}${checkboxes({ name: 'track_ids', id: `tracks-${j.id}`, label: 'Tracks covered', values: j.trackIds, options: trackOptions, hint: 'None ticked means every track.' })}${button('Save tracks', { variant: 'secondary', small: true })}</form></details></td>
        <td class="n">${j.submitted}/${j.assigned}</td>
        <td>${j.has_password ? pill('active', 'success') : pill('invite pending', 'info')}</td>
        <td>${j.submitted === 0 ? confirmForm(ctx, `/organize/${event.slug}/judges/${j.id}/remove`, 'Remove', `Removes ${j.name} and their ${j.assigned} unfinished assignment(s).`, 'Yes, remove', 'danger') : html`<span class="muted">has reviews</span> <a class="small" href="/organize/${event.slug}/judges/${j.id}/record.json">signed record</a>`}</td>
      </tr>`)}</tbody></table></div>`}
  </div>
  <aside>
    ${section('Invite a judge', html`${formErrors(view.errors)}
      <form method="post" action="/organize/${event.slug}/judges" class="stack-form" novalidate>${csrf(ctx)}
        ${input({ name: 'name', label: 'Name', value: typeof view.values?.name === 'string' ? view.values.name : '', required: true, error: view.errors?.name })}
        ${input({ name: 'email', label: 'Email', type: 'email', value: typeof view.values?.email === 'string' ? view.values.email : '', required: true, error: view.errors?.email })}
        ${checkboxes({ name: 'track_ids', label: 'Tracks this judge covers', values: Array.isArray(chosen) ? chosen : chosen ? [chosen] : [], options: trackOptions, hint: 'None ticked means every track. Auto-assignment only gives a judge projects in their tracks.', error: view.errors?.track_ids })}
        ${button('Invite judge')}
      </form>
      <p class="hint">A judge cannot be on a team in this event, and cannot also organize it.</p>`)}
  </aside>
</div>`, { lead: 'Who judges, and which tracks they cover.' });
}

// Assignments ------------------------------------------------------------------------------

export interface AssignmentsView {
  event: EventRow;
  assignments: AssignmentView[];
  projects: (ProjectRow & { team_name: string; track_name: string | null; reviews: number; assigned: number })[];
  judges: { id: string; name: string }[];
  shortfalls?: { title: string; have: number; missing: number; reason: string }[] | null;
  created?: number | null;
  errors?: Record<string, string>;
}

export function assignmentsPage(ctx: Ctx, view: AssignmentsView): SafeHtml {
  const { event } = view;
  const live = view.projects.filter((p) => p.status === 'submitted' && !p.superseded_by);
  const byProject = new Map<string, AssignmentView[]>();
  for (const a of view.assignments) byProject.set(a.project_id, [...(byProject.get(a.project_id) ?? []), a]);
  const short = live.filter((p) => p.assigned < event.reviews_per_project).length;
  const nothingToAssign = live.length === 0
    ? 'Nothing to assign yet: no project has been submitted.'
    : view.judges.length === 0
      ? html`Invite judges first, on the <a href="/organize/${event.slug}/judges">Judges</a> tab.`
      : null;
  return organizerPage(ctx, event, 'assignments', 'Assignments', html`
${view.created !== null && view.created !== undefined ? notice(view.shortfalls?.length ? 'warn' : 'success', html`Created ${view.created} assignment(s).${view.shortfalls?.length ? html` ${view.shortfalls.length} project(s) are still short: <ul>${view.shortfalls.map((s) => html`<li>${s.title}: ${s.have} of ${event.reviews_per_project}, ${s.reason}</li>`)}</ul>` : ''}`, 'Auto-assign finished.') : ''}
${formErrors(view.errors)}
<div class="two-col wide-left">
  <div>
    ${section('Coverage', html`<div class="table-wrap"><table class="data compact">
      <thead><tr><th scope="col">Project</th><th scope="col">Track</th><th scope="col" class="n">Reviews</th><th scope="col">Judges</th></tr></thead>
      <tbody>${live.map((p) => html`<tr>
        <td><a href="/projects/${p.id}">${p.title}</a> <code class="muted">${p.id}</code></td><td>${p.track_name ?? ''}</td>
        <td class="n">${p.reviews}/${p.assigned}${p.assigned < event.reviews_per_project ? html` ${pill(`needs ${event.reviews_per_project - p.assigned}`, 'warn')}` : ''}</td>
        <td><ul class="judge-chips">${(byProject.get(p.id) ?? []).map((a) => html`<li class="${cx('chip', a.review_status === 'submitted' && 'chip-done', a.review_status === 'draft' && 'chip-draft')}">
          <a href="/judge/reviews/${a.id}">${a.judge_name}</a>${a.source !== 'fixture' ? html` <span class="muted">${a.source}</span>` : ''}
          ${a.review_status !== 'submitted' ? actionForm(ctx, `/organize/${event.slug}/assignments/${a.id}/remove`, '×', { small: true, variant: 'ghost' }) : ''}</li>`)}</ul></td>
      </tr>`)}</tbody></table></div>`, { lead: `Submitted reviews / assigned judges, per project. Target: ${event.reviews_per_project}.` })}
  </div>
  <aside>
    ${section('Auto-assign', html`<p>${short ? `${short} project(s) have fewer than ${event.reviews_per_project} judges.` : 'Every project has enough judges.'} Auto-assign fills the gaps: each judge only gets projects in their tracks, never their own team’s, and the least-loaded eligible judge takes each slot. Existing assignments are kept.</p>
      ${nothingToAssign ? html`<p class="hint">${nothingToAssign}</p>` : actionForm(ctx, `/organize/${event.slug}/assignments/auto`, 'Fill gaps automatically', { variant: 'primary' })}`)}
    ${section('Assign by hand', nothingToAssign ? html`<p class="hint">${nothingToAssign}</p>` : html`<form method="post" action="/organize/${event.slug}/assignments" class="stack-form">${csrf(ctx)}
      ${select({ name: 'project_id', label: 'Project', blank: 'Choose a project', options: live.map((p) => ({ value: p.id, label: `${p.title} (${p.id})` })), error: view.errors?.project_id })}
      ${select({ name: 'judge_id', label: 'Judge', blank: 'Choose a judge', options: view.judges.map((j) => ({ value: j.id, label: j.name })), error: view.errors?.judge_id })}
      ${button('Assign', { variant: 'secondary' })}</form>`)}
  </aside>
</div>`, { lead: 'Who reviews what. Only unfinished assignments can be removed.' });
}

// Projects and duplicates ---------------------------------------------------------------

export function projectsAdminPage(ctx: Ctx, event: EventRow, projects: AssignmentsView['projects'], duplicates: TeamSubmissions[]): SafeHtml {
  const statusPill = (p: ProjectRow) => (p.superseded_by ? pill('replaced', 'neutral') : p.status === 'submitted' ? pill('submitted', 'success') : p.status === 'draft' ? pill('draft', 'warn') : pill('withdrawn', 'neutral'));
  return organizerPage(ctx, event, 'projects', 'Projects', html`
${duplicates.length ? section('Duplicate submissions', html`${duplicates.map((d) => html`<div class="dup-group"><p><strong>${d.team.name}</strong> <code class="muted">${d.team.id}</code> submitted ${d.projects.length} times. One live project per team: the one marked “counts” is judged and ranked; the others stay on record with their reviews.</p>
  <ul class="row-list">${d.projects.map((p) => html`<li><span><a href="/projects/${p.id}">${p.title}</a> <code class="muted">${p.id}</code> submitted ${when(p.submitted_at, ctx.now, { relative: false })} ${p.superseded_by ? pill('replaced', 'neutral') : pill('counts', 'success')}</span>
    ${p.superseded_by && p.status === 'submitted' ? confirmForm(ctx, `/organize/${event.slug}/projects/${p.id}/count`, 'Make this one count', `${p.id} becomes the team’s judged submission and the others are marked replaced. Reviews stay attached to the project they were written for. The change is audited.`, 'Yes, switch', 'secondary') : ''}</li>`)}</ul></div>`)}`, { id: 'duplicates', lead: 'Found at import or when a team resubmits. Nothing is merged or deleted.' }) : ''}
${section(`All projects (${projects.length})`, html`<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Project</th><th scope="col">Team</th><th scope="col">Track</th><th scope="col">Status</th><th scope="col" class="n">Reviews</th><th scope="col">Submitted</th></tr></thead>
  <tbody>${projects.map((p) => html`<tr><td><a href="/projects/${p.id}">${p.title}</a> <code class="muted">${p.id}</code></td><td>${p.team_name}</td><td>${p.track_name ?? ''}</td><td>${statusPill(p)}</td><td class="n">${p.reviews}/${p.assigned}</td><td>${p.submitted_at ? when(p.submitted_at, ctx.now, { relative: false }) : html`<span class="muted">–</span>`}</td></tr>`)}</tbody>
</table></div>`, { lead: 'Drafts, withdrawn and replaced projects included. The public gallery shows only submitted, current ones.' })}`);
}

// Results ------------------------------------------------------------------------------------

export function resultsAdminPage(ctx: Ctx, event: EventRow, standings: Standings, snapshots: Snapshot[], commitment: CommitmentStatus | null = null, pairwise: PairwiseSummary | null = null): SafeHtml {
  const phase = phaseOf(event, ctx.now);
  const ranked = standings.standings.filter((s) => s.rank !== null);
  const prizePlaces = standings.uncertainty?.prizePlaces ?? 3;
  const moves = (s: Standings['standings'][number]) => {
    if (s.rank === null || s.raw_rank === null || s.rank === s.raw_rank) return html`<span class="muted">–</span>`;
    const delta = s.raw_rank - s.rank;
    return html`<span class="${cx('move', delta > 0 ? 'up' : 'down')}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}<span class="sr-only"> places ${delta > 0 ? 'up' : 'down'} from the raw ranking</span></span>`;
  };
  return organizerPage(ctx, event, 'results', 'Results', html`
${event.results_published_at ? notice('success', html`Published ${when(event.results_published_at, ctx.now)}. <a href="/events/${event.slug}/results">View the public page</a>.`, 'Live.') : notice('info', 'This is a private preview, recomputed on every load. Nobody else sees a ranking until you publish.', 'Preview.')}
<div class="stat-row">
  ${stat('Ranked projects', String(ranked.length), `${standings.standings.length - ranked.length} without reviews`)}
  ${stat('Reviews used', String(standings.reviewCount), 'submitted reviews of current projects')}
  ${stat('Overall mean', standings.mu.toFixed(3), html`μ, on the ${event.score_min}–${event.score_max} scale`)}
  ${stat('Fit', `${standings.iterations} iterations`, standings.converged ? 'converged' : 'did not converge')}
</div>
<div class="publish-bar">
  ${phase.key === 'open' || phase.key === 'upcoming'
    ? notice('info', 'Close submissions before publishing.')
    : event.results_published_at
      ? html`${confirmForm(ctx, `/organize/${event.slug}/results/publish`, 'Publish again with current data', 'Creates a new snapshot from the reviews as they are now. The previous snapshot is kept and marked superseded.', 'Yes, republish')} ${confirmForm(ctx, `/organize/${event.slug}/results/unpublish`, 'Withdraw results', 'The public results page goes back to “not published”. Snapshots are kept.', 'Yes, withdraw', 'danger')}`
      : confirmForm(ctx, `/organize/${event.slug}/results/publish`, 'Publish results', html`Freezes this ranking with its method (${standings.method}, λ = ${standings.lambda}) and weights, closes judging, and shows the results publicly. You can republish later; every snapshot is kept.`, 'Yes, publish')}
  ${linkButton(`/api/export.csv?event=${event.slug}&kind=results`, 'Download CSV')}
  ${event.results_published_at ? html`${linkButton(`/organize/${event.slug}/results/capsule.html`, 'Download signed results capsule')} ${linkButton(`/events/${event.slug}/results.json`, 'Signed JSON', 'ghost')}` : ''}
</div>
${section('Ranking preview', html`<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Rank</th><th scope="col">Project</th><th scope="col">Track</th><th scope="col" class="n">Normalized</th><th scope="col" class="n">Raw mean</th><th scope="col">vs raw</th><th scope="col" class="n">Likely place (90%)</th><th scope="col" class="n">Top ${prizePlaces}</th><th scope="col" class="n">Reviews</th></tr></thead>
  <tbody>${standings.standings.map((s) => html`<tr>
    <td class="rank">${s.rank ?? '–'}</td><td><a href="/projects/${s.project_id}">${s.title}</a>${s.low_coverage ? html` ${pill(s.review_count === 0 ? 'no reviews' : 'few reviews', 'warn')}` : ''}</td><td>${s.track_name ?? ''}</td>
    <td class="n">${num(s.score, 3)}</td><td class="n">${num(s.raw_mean, 3)}</td><td>${moves(s)}</td><td class="n">${placeRange(s.rank_lo, s.rank_hi)}</td><td class="n">${share(s.podium_share)}</td><td class="n">${s.review_count}</td></tr>`)}</tbody>
</table></div>`, { lead: html`Rubric weights: ${standings.weights.map((w) => `${w.name} ${Math.round(w.share * 100)}%`).join(', ')}. Normalized = μ + a<sub>p</sub>, the average with each judge’s offset removed.` })}
${certaintySection(standings, commitment)}
${pairwiseSection(pairwise)}
${section('Judge offsets', html`<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Judge</th><th scope="col" class="n">Reviews</th><th scope="col" class="n">Mean given</th><th scope="col" class="n">Offset b<sub>j</sub></th><th scope="col">Flags</th></tr></thead>
  <tbody>${standings.judges.map((j) => html`<tr><td>${j.name} <code class="muted">${j.judge_id}</code></td><td class="n">${j.review_count}</td><td class="n">${num(j.mean_given, 2)}</td><td class="n">${signed(j.offset, 3)}</td><td>${flagPills(j.flags)}</td></tr>`)}</tbody>
</table></div>`, { lead: html`Negative means harsher than the panel, positive more generous. Offsets are shrunk toward zero (λ = ${standings.lambda}), so judges with few reviews stay close to 0. See <a href="/about#normalization">the method</a>.` })}
${snapshots.length ? section('Published snapshots', html`<ul class="row-list">${snapshots.map((s) => html`<li><span><code>${s.id}</code> ${when(s.published_at, ctx.now)} by ${s.published_by_name ?? 'unknown'} · ${s.review_count} reviews · ${s.method}, λ ${s.lambda}</span>${s.superseded_at ? pill('superseded', 'neutral') : pill('current', 'success')}</li>`)}</ul>`) : ''}`, { lead: 'Normalized ranking, raw means beside it, and the judge offsets that separate them.' });
}

export function placeRange(lo: number | null, hi: number | null): Renderable {
  if (lo === null || hi === null) return html`<span class="muted">–</span>`;
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

export function share(value: number | null): Renderable {
  return value === null ? html`<span class="muted">–</span>` : `${Math.round(value * 100)}%`;
}

/** Stability, the prize line and the method commitment: whether the ranking deserves the podium it shows. */
function certaintySection(standings: Standings, commitment: CommitmentStatus | null): SafeHtml {
  const u = standings.uncertainty;
  if (!u) return html``;
  const title = new Map(standings.standings.map((s) => [s.project_id, s.title]));
  const judge = new Map(standings.judges.map((j) => [j.judge_id, j.name]));
  const st = u.stability;
  const influential = st.influential.map((i) => html`<li>Without <strong>${judge.get(i.judge) ?? i.judge}</strong> <code class="muted">${i.judge}</code>: ${i.changesWinner ? html`first place goes to ${title.get(i.winner ?? '') ?? '–'}` : 'first place holds'}${i.changesPodium ? html`, and the top ${u.prizePlaces} become ${i.podium.map((p) => title.get(p) ?? p).join(', ')}` : ''}.</li>`);
  return section('How sure is this ranking?', html`
<p>First place (${title.get(st.winner ?? '') ?? '–'}) holds in <strong>${st.winnerHolds} of ${st.refits}</strong> refits that each leave one judge out; the top ${u.prizePlaces} hold in <strong>${st.podiumHolds} of ${st.refits}</strong>. One review's noise is about ${u.sigma.toFixed(2)} points.</p>
${influential.length ? html`<details><summary>${influential.length} judge${influential.length === 1 ? '' : 's'} whose removal changes the podium</summary><ul>${influential}</ul></details>` : html`<p>No single judge decides the podium.</p>`}
<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Places</th><th scope="col">Ahead</th><th scope="col">Behind</th><th scope="col" class="n">Gap</th><th scope="col" class="n">Order kept</th><th scope="col">Reading</th><th scope="col" class="n">Reviews each to separate</th></tr></thead>
  <tbody>${u.separations.map((s) => html`<tr><td>${s.place} and ${s.place + 1}</td><td>${title.get(s.above) ?? s.above}</td><td>${title.get(s.below) ?? s.below}</td><td class="n">${s.gap.toFixed(3)}</td><td class="n">${Math.round(s.orderShare * 100)}%</td>
    <td>${s.separated ? pill('separated', 'success') : pill('statistical tie', 'warn')}</td>
    <td class="n">${s.reviewsEach === null ? html`<span class="muted">a true tie</span>` : s.reviewsEach === 0 ? '0' : s.reviewsEach > 10 ? html`${s.reviewsEach} <span class="muted">(not practical)</span>` : String(s.reviewsEach)}</td></tr>`)}</tbody>
</table></div>
<p>${commitment
    ? commitment.unchanged
      ? html`${pill('method unchanged', 'success')} The method, λ, scale and weights were fixed ${formatUtc(commitment.committedAt)} when the first score arrived (fingerprint <code>${commitment.committedHash.slice(0, 12)}</code>), and still match.`
      : html`${pill('method changed', 'warn')} The configuration no longer matches the one fixed when scoring began (fingerprint <code>${commitment.committedHash.slice(0, 12)}</code>); ${commitment.laterRubricChanges} rubric edit(s) since then are on the audit trail. Publishing will say so.`
    : html`<span class="muted">The method is fixed, and fingerprinted, when the first score arrives.</span>`}</p>`,
  { lead: html`90% intervals from ${u.replicates} seeded simulations that keep this event's judge–project layout. Two projects whose order flips often are a statistical tie, however the table sorts them. See <a href="/about#normalization">the method</a>.` });
}

// Audit ---------------------------------------------------------------------------------------

export function auditList(ctx: Ctx, rows: AuditRow[]): SafeHtml {
  return html`<ol class="audit-list">${rows.map((r) => html`<li class="${cx(r.action === 'access.denied' && 'denied')}">
    <div class="audit-meta">${when(r.at, ctx.now)} · <code>${r.action}</code></div>
    <div>${r.summary}</div>
    <div class="audit-meta">${r.actor_label}${r.ip ? html` · ${r.ip}` : ''}</div>
  </li>`)}</ol>`;
}

export function auditPage(ctx: Ctx, event: EventRow, rows: AuditRow[], actions: string[], filter: string | null, nextBefore: number | null, chain: ChainReport | null = null): SafeHtml {
  return organizerPage(ctx, event, 'audit', 'Audit trail', html`
${chain ? chainNotice(chain) : ''}
<form method="get" class="filters compact" action="/organize/${event.slug}/audit">
  ${select({ name: 'action', label: 'Show', value: filter, blank: 'Everything', options: [{ value: 'access.denied', label: 'Refused access attempts' }, ...actions.filter((a) => a !== 'access.denied').map((a) => ({ value: a, label: a }))] })}
  <div class="filter-actions">${button('Filter', { variant: 'secondary' })} ${linkButton(`/api/export.csv?event=${event.slug}&kind=audit`, 'Download CSV', 'ghost')}</div>
</form>
${rows.length ? auditList(ctx, rows) : empty('Nothing here', 'No entries match this filter.')}
${nextBefore ? html`<p>${linkButton(`/organize/${event.slug}/audit?${new URLSearchParams({ ...(filter ? { action: filter } : {}), before: String(nextBefore) })}`, 'Older entries')}</p>` : ''}`,
  { lead: 'Every change and every refused attempt, newest first. Append-only: the database rejects edits and deletions of this log.' });
}

function chainNotice(chain: ChainReport): SafeHtml {
  if (!chain.ok && chain.broken) {
    return notice('error', html`Entry #${chain.broken.id} does not verify: ${chain.broken.reason}. Entries before it are intact. Compare with a published results capsule, which quotes the chain's head at publication.`, 'The audit chain is broken.');
  }
  return notice('success', html`All ${chain.verified} chained entries verify${chain.unchained ? html` (${chain.unchained} older entries predate the chain)` : ''}. Head: #${chain.head?.id ?? '–'} <code>${chain.head?.hash.slice(0, 16) ?? ''}…</code>. Every entry carries a SHA-256 of the one before it, so an edit to the database file breaks every later hash.`, 'Tamper-evident.');
}

// Export --------------------------------------------------------------------------------------

export function exportPage(ctx: Ctx, event: EventRow): SafeHtml {
  return organizerPage(ctx, event, 'export', 'Export', html`
<ul class="export-list">${EXPORT_KINDS.map((kind) => html`<li class="card"><h2 class="card-title">${kind}.csv</h2><p>${EXPORT_DESCRIPTIONS[kind]}</p>${linkButton(`/api/export.csv?event=${event.slug}&kind=${kind}`, 'Download', 'secondary', true)}</li>`)}</ul>
<p class="hint">RFC 4180 CSV, UTF-8. Cells that a spreadsheet would run as a formula are prefixed with an apostrophe. The same files are available to scripts at <code>/api/export.csv?event=${event.slug}&amp;kind=…</code> with an organizer’s session.</p>`,
  { lead: 'Take your data with you at any stage, before or after publishing.' });
}
