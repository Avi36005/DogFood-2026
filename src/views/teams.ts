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

