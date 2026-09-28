import { phaseOf } from '../domain/events.ts';
import type { EventRow, ProjectRow, Role, TeamRow, UserRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { button, csrf, empty, formErrors, input, linkButton, notice, pageHeader, pill, section, when } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';
import { phasePill } from './public.ts';

export function loginPage(ctx: Ctx, values: { email?: string } = {}, error?: string): SafeHtml {
  const next = ctx.safeNext();
  return page(ctx, {
    title: 'Sign in',
    body: html`<div class="auth-card">
  <h1>Sign in</h1>
  ${error ? notice('error', error) : ''}
  <form method="post" action="/login?next=${encodeURIComponent(next)}">
    ${csrf(ctx)}
    ${input({ name: 'email', label: 'Email', type: 'email', value: values.email, autocomplete: 'username', required: true })}
    ${input({ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', required: true })}
    <div class="form-actions">${button('Sign in')}</div>
  </form>
  <p class="muted">New here? <a href="/signup?next=${encodeURIComponent(next)}">Create an account</a>. Forgot your password? An administrator can give you a one-time reset link; there is no mail server.</p>
  ${ctx.config.demo ? notice('info', html`Demo accounts use the password <code>forgeboard-demo</code>: <code>organizer@forgeboard.local</code>, <code>admin@forgeboard.local</code>, judges <code>diego.herrera@example.org</code> and <code>ines.rocha@example.org</code>, participant <code>priya1@example.org</code>.`, 'Demo mode.') : ''}
</div>`,
  });
}

export function signupPage(ctx: Ctx, values: Record<string, string> = {}, errors?: Record<string, string>): SafeHtml {
  const next = ctx.safeNext();
  return page(ctx, {
    title: 'Create an account',
    body: html`<div class="auth-card">
  <h1>Create an account</h1>
  <p class="muted">One account works for every event on this instance: compete in one, judge another.</p>
  ${formErrors(errors)}
  <form method="post" action="/signup?next=${encodeURIComponent(next)}" novalidate>
    ${csrf(ctx)}
    ${input({ name: 'name', label: 'Your name', value: values.name, autocomplete: 'name', required: true, error: errors?.name })}
    ${input({ name: 'email', label: 'Email', type: 'email', value: values.email, autocomplete: 'email', required: true, error: errors?.email })}
    ${input({ name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', required: true, error: errors?.password, hint: 'At least 8 characters.' })}
    <div class="form-actions">${button('Create account')}</div>
  </form>
  <p class="muted">Already have one? <a href="/login?next=${encodeURIComponent(next)}">Sign in</a>.</p>
</div>`,
  });
}

export function passwordLinkPage(ctx: Ctx, view: { user: UserRow; purpose: 'setup' | 'reset' | 'judge'; eventName?: string; action: string; error?: string }): SafeHtml {
  const heading = view.purpose === 'reset' ? 'Choose a new password' : view.purpose === 'judge' ? `Judge ${view.eventName}` : 'Set up your account';
  return page(ctx, {
    title: heading,
    body: html`<div class="auth-card">
  <h1>${heading}</h1>
  <p>${view.purpose === 'judge' ? html`You were invited to judge <strong>${view.eventName}</strong> as <strong>${view.user.email}</strong>. Choose a password to accept.` : html`For <strong>${view.user.email}</strong>. This link works once.`}</p>
  ${view.error ? notice('error', view.error) : ''}
  <form method="post" action="${view.action}">
    ${csrf(ctx)}
    <input type="text" name="username" value="${view.user.email}" autocomplete="username" hidden>
    ${input({ name: 'password', label: 'New password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters.' })}
    <div class="form-actions">${button(view.purpose === 'judge' ? 'Accept and sign in' : 'Save password and sign in')}</div>
  </form>
</div>`,
  });
}

export function linkUsedPage(ctx: Ctx, message: string): SafeHtml {
  return page(ctx, {
    title: 'Link not valid',
    body: html`<div class="auth-card"><h1>This link is not valid</h1><p>${message}</p><p>${linkButton('/login', 'Sign in', 'primary')}</p></div>`,
  });
}

export function accountPage(ctx: Ctx, user: UserRow, errors?: Record<string, string>): SafeHtml {
  return page(ctx, {
    title: 'Account',
    nav: 'account',
    body: html`
${pageHeader(user.name, { eyebrow: 'Your account', lead: user.email })}
${section('Change password', html`
  ${formErrors(errors)}
  <form method="post" action="/account/password" class="narrow-form">
    ${csrf(ctx)}
    <input type="text" name="username" value="${user.email}" autocomplete="username" hidden>
    ${input({ name: 'current_password', label: 'Current password', type: 'password', autocomplete: 'current-password', required: true, error: errors?.current_password })}
    ${input({ name: 'new_password', label: 'New password', type: 'password', autocomplete: 'new-password', required: true, error: errors?.new_password, hint: 'At least 8 characters. Your other sessions end when you change it.' })}
    <div class="form-actions">${button('Change password')}</div>
  </form>`)}`,
  });
}

export interface DashboardEntry {
  event: EventRow;
  roles: Set<Role>;
  team: TeamRow | null;
  project: ProjectRow | null;
  queue: { total: number; submitted: number } | null;
}

export function dashboardPage(ctx: Ctx, entries: DashboardEntry[], openEvents: EventRow[]): SafeHtml {
  const joinable = openEvents.filter((e) => !entries.some((entry) => entry.event.id === e.id));
  return page(ctx, {
    title: 'Dashboard',
    nav: 'dashboard',
    body: html`
${pageHeader(`Hello, ${ctx.user?.name}`, { eyebrow: 'Dashboard', lead: 'Your events, your team’s project and your judging work in one place.' })}
${entries.length === 0 ? empty('You are not in any event yet', 'Join an event that is open for submissions, or wait for an organizer’s invitation to judge.') : ''}
<div class="dash-grid">
${entries.map(({ event, roles, team, project, queue }) => html`<section class="card dash-card">
  <div class="card-top">${phasePill(phaseOf(event, ctx.now))} ${[...roles].map((r) => pill(r, r === 'organizer' ? 'dark' : r === 'judge' ? 'info' : 'neutral'))}</div>
  <h2 class="card-title"><a href="/events/${event.slug}">${event.name}</a></h2>
  <ul class="dash-list">
    ${roles.has('organizer') ? html`<li><a href="/organize/${event.slug}">Organizer console</a>: progress, judges, results.</li>` : ''}
    ${roles.has('judge') && queue ? html`<li><a href="/judge/${event.slug}">Judging queue</a>: ${queue.submitted} of ${queue.total} reviews submitted.</li>` : ''}
    ${team ? html`<li>Team <a href="/events/${event.slug}/team">${team.name}</a>${project ? html`, project <a href="/projects/${project.id}">${project.title}</a> ${pill(project.status, project.status === 'submitted' ? 'success' : project.status === 'draft' ? 'warn' : 'neutral')}` : ', no project yet'}.</li>` : ''}
    <li class="muted">Deadline ${when(event.submissions_close_at, ctx.now)}</li>
  </ul>
</section>`)}
</div>
${joinable.length ? section('Open for submissions', html`<ul class="plain-list">${joinable.map((e) => html`<li><a href="/events/${e.slug}">${e.name}</a>, closes ${when(e.submissions_close_at, ctx.now)}</li>`)}</ul>`) : ''}`,
  });
}
