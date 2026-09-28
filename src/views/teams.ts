import { submissionsOpen } from '../domain/events.ts';
import type { MemberRow, InviteView } from '../domain/teams.ts';
import type { EventRow, ProjectRow, TeamRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { actionForm, button, confirmForm, csrf, empty, formErrors, input, linkButton, notice, pageHeader, pill, section, when } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';

export interface TeamPageView {
  event: EventRow;
  team: TeamRow | null;
  members: MemberRow[];
  project: ProjectRow | null;
  inviteLink: string | null;
  isCaptain: boolean;
  blockedReason: string | null;
  errors?: Record<string, string>;
  values?: Record<string, string>;
}

export function teamPage(ctx: Ctx, view: TeamPageView): SafeHtml {
  const { event, team } = view;
  const open = submissionsOpen(event, ctx.now);
  return page(ctx, {
    title: team ? team.name : `Join ${event.name}`,
    nav: 'dashboard',
    body: html`
${pageHeader(team ? team.name : 'Join the event', { eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>`, lead: html`Teams of up to ${event.max_team_size}. Submissions close ${when(event.submissions_close_at, ctx.now)}.` })}
${!open ? notice('warn', 'Submissions are closed, so teams and projects can no longer change.', 'Closed.') : ''}
${team ? teamDetails(ctx, view) : view.blockedReason ? notice('info', view.blockedReason) : open ? html`
<div class="two-col even">
  ${section('Start a team', html`
    ${formErrors(view.errors)}
    <form method="post" action="/events/${event.slug}/team" class="narrow-form">
      ${csrf(ctx)}
      ${input({ name: 'name', label: 'Team name', value: view.values?.name, required: true, maxlength: 80, error: view.errors?.name })}
      <div class="form-actions">${button('Create team')}</div>
    </form>
    <p class="muted">You will get an invite link to share with your teammates.</p>`)}
  ${section('Join a team', html`<p>Ask your team’s captain for their invite link and open it. Links expire after 14 days, and a captain can replace theirs at any time.</p>`)}
</div>` : empty('Submissions are closed', 'This event no longer accepts new teams.')}`,
  });
}

function teamDetails(ctx: Ctx, view: TeamPageView): SafeHtml {
  const { event, team, members, project } = view;
  const open = submissionsOpen(event, ctx.now);
  if (!team) return html``;
  return html`
<div class="two-col">
  <div>
    ${section('Project', project
      ? html`<p class="project-line"><a href="/projects/${project.id}"><strong>${project.title}</strong></a> ${pill(project.status, project.status === 'submitted' ? 'success' : 'warn')}</p>
         <p class="muted">${project.status === 'submitted' ? html`Submitted ${when(project.submitted_at, ctx.now)}. You can keep editing until the deadline.` : 'A draft is private. Submit it before the deadline to enter.'}</p>
         ${open ? html`<p>${linkButton(`/projects/${project.id}/edit`, project.status === 'draft' ? 'Continue editing' : 'Edit project', 'primary')}</p>` : ''}`
      : open
        ? html`<p>Your team has not started a project yet.</p><p>${linkButton(`/projects/new?event=${event.slug}`, 'Start the project', 'primary')}</p>`
        : html`<p class="muted">Your team did not submit a project.</p>`)}
    ${section('Invite teammates', view.inviteLink
      ? html`${notice('success', 'Copy this link now. For security only a fingerprint of it is stored, so it cannot be shown again; you can always create a new one.', 'Invite link created.')}
         <div class="copy-row"><input class="copy-field" type="text" readonly value="${view.inviteLink}" aria-label="Invite link" id="invite-link"><button type="button" class="btn btn-secondary" data-copy="invite-link">Copy</button></div>`
      : view.isCaptain && open
        ? html`<p>Anyone with your team’s link can join until the team is full (${members.length} of ${event.max_team_size}).</p>${actionForm(ctx, `/events/${event.slug}/team/invite`, 'Create a new invite link')}<p class="hint">Creating a new link stops the old one working.</p>`
        : html`<p class="muted">${open ? 'Ask your captain for the invite link.' : 'Teams are locked.'}</p>`)}
  </div>
  <aside>
    ${section(`Members (${members.length}/${event.max_team_size})`, html`<ul class="plain-list">${members.map((m) => html`<li>${m.name}${m.is_captain ? html` ${pill('captain', 'dark')}` : ''}${m.id === ctx.user?.id ? html` <span class="muted">(you)</span>` : ''}</li>`)}</ul>`)}
    ${!open
      ? ''
      : members.length === 1 && project
        ? html`<p class="hint">You are the only member and the team has a project, so you cannot leave. Withdraw the project first, or invite someone to take it over.</p>`
        : confirmForm(ctx, `/events/${event.slug}/team/leave`, 'Leave team', members.length === 1 ? 'You are the only member, so the empty team will be removed.' : 'You can join another team afterwards, until the deadline.', 'Yes, leave', 'danger')}
  </aside>
</div>`;
}

export function joinPage(ctx: Ctx, invite: InviteView, currentTeam: TeamRow | null, blockedReason: string | null): SafeHtml {
  const { team, event, members } = invite;
  const full = members.length >= event.max_team_size;
  const already = members.some((m) => m.id === ctx.user?.id);
  const open = submissionsOpen(event, ctx.now);
  const canJoin = Boolean(ctx.user) && !already && !currentTeam && !full && open && !blockedReason;
  return page(ctx, {
    title: `Join ${team.name}`,
    body: html`<div class="auth-card">
  <p class="eyebrow">${event.name}</p>
  <h1>Join ${team.name}</h1>
  <p>${members.length} of ${event.max_team_size} places taken: ${members.map((m) => m.name).join(', ')}.</p>
  ${already ? notice('info', 'You are already on this team.') : ''}
  ${currentTeam && !already ? notice('warn', `You are on ${currentTeam.name}. Leave it first to join this team.`) : ''}
  ${full && !already ? notice('warn', 'This team is full.') : ''}
  ${!open ? notice('warn', 'Submissions are closed, so teams are locked.') : ''}
  ${blockedReason ? notice('warn', blockedReason) : ''}
  ${!ctx.user
    ? html`<p>${linkButton(`/login?next=${encodeURIComponent(ctx.url.pathname)}`, 'Sign in to join', 'primary')} ${linkButton(`/signup?next=${encodeURIComponent(ctx.url.pathname)}`, 'Create an account')}</p>`
    : already || currentTeam
      ? html`<p>${linkButton(`/events/${event.slug}/team`, 'Go to your team', 'primary')}</p>`
      : canJoin
        ? html`<form method="post" action="${ctx.url.pathname}">${csrf(ctx)}${button(`Join ${team.name}`)}</form>`
        : ''}
  <p class="hint">Invite link valid until ${when(invite.expiresAt, ctx.now, { relative: false })}.</p>
</div>`,
  });
}
