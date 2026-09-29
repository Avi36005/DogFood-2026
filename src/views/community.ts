import type { CommentView } from '../domain/comments.ts';
import { COMMENT_MAX } from '../domain/comments.ts';
import type { EventRow, ProjectRow } from '../domain/types.ts';
import type { BallotChoice, BallotCluster, Tally, VotePhase, VoteSettings } from '../domain/voting.ts';
import type { Ctx } from '../http/context.ts';
import { formatUtc, toDatetimeLocal } from '../util/time.ts';
import { actionForm, button, csrf, empty, formErrors, input, linkButton, notice, pageHeader, pill, section, select, stat, textarea, when } from './components.ts';
import { cx, html, type Renderable, type SafeHtml } from './html.ts';
import { page } from './layout.ts';

// Voting: the public side ------------------------------------------------------------------

export type VoteView =
  | { kind: 'off' }
  | { kind: 'upcoming' | 'closed'; settings: VoteSettings }
  | { kind: 'published'; settings: VoteSettings }
  | { kind: 'sign-in'; settings: VoteSettings }
  | { kind: 'code'; settings: VoteSettings; error?: string }
  | { kind: 'ineligible'; settings: VoteSettings; reason: string }
  | { kind: 'ballot'; settings: VoteSettings; choices: BallotChoice[]; code: string | null; picked?: string[]; error?: string }
  | { kind: 'cast'; settings: VoteSettings; castAt: string };

function windowText(settings: VoteSettings): string {
  return `${formatUtc(settings.opens_at)} to ${formatUtc(settings.closes_at)}`;
}

export function votePage(ctx: Ctx, event: EventRow, view: VoteView): SafeHtml {
  const body = (() => {
    switch (view.kind) {
      case 'off':
        return empty('No community vote', 'This event is judged by its panel only.');
      case 'upcoming':
        return notice('info', html`Voting opens ${when(view.settings.opens_at, ctx.now)} and closes ${when(view.settings.closes_at, ctx.now)}.`, 'Not open yet.');
      case 'closed':
        return notice('info', html`Voting closed ${when(view.settings.closes_at, ctx.now)}. The organizers publish the tally once they have reviewed the ballots.`, 'Voting has closed.');
      case 'published':
        return html`${notice('success', html`Voting closed ${when(view.settings.closes_at, ctx.now)}.`, 'The tally is out.')}<p>${linkButton(`/events/${event.slug}/vote/results`, 'See the community vote', 'primary')}</p>`;
      case 'sign-in':
        return html`${notice('info', 'Voting is open to signed-in accounts: one ballot each.', 'Sign in to vote.')}<p>${linkButton(`/login?next=${encodeURIComponent(`/events/${event.slug}/vote`)}`, 'Sign in', 'primary')} ${linkButton(`/signup?next=${encodeURIComponent(`/events/${event.slug}/vote`)}`, 'Create an account')}</p>`;
      case 'ineligible':
        return notice('warn', view.reason, 'You cannot vote in this event.');
      case 'code':
        return html`<form method="post" action="/events/${event.slug}/vote/code" class="narrow-form">${csrf(ctx)}
  ${input({ name: 'code', label: 'Your voter code', required: true, autocomplete: 'off', placeholder: 'abcd-efgh-jkmn', error: view.error, hint: 'Printed on the card you were given at the venue. One code is one ballot.' })}
  ${button('Open my ballot')}
</form>`;
      case 'cast':
        return notice('success', html`Your ballot was recorded ${when(view.castAt, ctx.now)}. Ballots are final. The tally stays hidden until voting closes on ${formatUtc(view.settings.closes_at)} and the organizers publish it.`, 'Thank you for voting.');
      case 'ballot':
        return ballotForm(ctx, event, view);
    }
  })();
  return page(ctx, {
    title: `Vote · ${event.name}`,
    nav: 'events',
    body: html`
${pageHeader('Community vote', { eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>`, lead: 'settings' in view ? html`Open ${windowText(view.settings)}. Approve up to ${view.settings.max_picks} project(s) you would give a prize to.` : undefined })}
${body}`,
  });
}

function ballotForm(ctx: Ctx, event: EventRow, view: Extract<VoteView, { kind: 'ballot' }>): SafeHtml {
  const picked = new Set(view.picked ?? []);
  return html`<form method="post" action="/events/${event.slug}/vote" class="ballot">${csrf(ctx)}
  ${view.code ? html`<input type="hidden" name="code" value="${view.code}">` : ''}
  ${view.error ? notice('error', view.error) : ''}
  <p class="hint">Projects are listed in an order drawn for you alone, so no project gains from being first. You can approve up to <strong>${view.settings.max_picks}</strong>. A ballot is final once cast.</p>
  <fieldset class="ballot-list">
    <legend class="sr-only">Projects</legend>
    ${view.choices.map((c, i) => html`<label class="${cx('ballot-item', c.own && 'own')}">
      <input type="checkbox" name="pick" value="${c.id}" id="pick-${i}"${picked.has(c.id) ? html` checked` : ''}${c.own ? html` disabled` : ''}>
      <span><strong>${c.title}</strong> <span class="muted">· ${c.team_name}${c.track_name ? ` · ${c.track_name}` : ''}</span>${c.own ? html` ${pill('your team', 'neutral')}` : ''}<br><span class="muted">${c.summary}</span> <a href="/projects/${c.id}">details</a></span>
    </label>`)}
  </fieldset>
  ${button('Cast my ballot')}
</form>`;
}

export function voteResultsPage(ctx: Ctx, event: EventRow, settings: VoteSettings | null, phase: VotePhase, tally: Tally | null, isOrganizer: boolean): SafeHtml {
  const hidden = !tally || (!settings?.published_at && !isOrganizer);
  return page(ctx, {
    title: `Community vote · ${event.name}`,
    nav: 'events',
    body: html`
${pageHeader('Community vote', { eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>`, lead: settings ? html`Voting ${phase === 'open' ? 'is open' : phase === 'upcoming' ? 'opens' : 'ran'} ${windowText(settings)}.` : undefined })}
${hidden
  ? empty('Hidden for now', settings ? 'The tally stays with the organizers until voting has closed and they publish it, so an early lead cannot steer the vote.' : 'This event has no community vote.')
  : html`${!settings?.published_at ? notice('warn', 'Only organizers can see this until the vote is published.', 'Preview.') : ''}${tallyTable(tally as Tally)}`}`,
  });
}

function tallyTable(tally: Tally): SafeHtml {
  return html`<p>${tally.ballots} valid ballot(s)${tally.voided ? html`, ${tally.voided} voided by the organizers` : ''}. Each ballot approves up to the event's limit; a project's share is the part of all ballots that approve it.</p>
<div class="table-wrap"><table class="data compact">
  <thead><tr><th scope="col">Rank</th><th scope="col">Project</th><th scope="col">Team</th><th scope="col" class="n">Approvals</th><th scope="col" class="n">Share of ballots</th></tr></thead>
  <tbody>${tally.rows.map((r) => html`<tr${r.rank <= 3 && r.votes > 0 ? html` class="podium"` : ''}><td class="rank">${r.rank}</td><td><a href="/projects/${r.project_id}">${r.title}</a></td><td>${r.team_name}</td><td class="n">${r.votes}</td><td class="n">${Math.round(r.share * 100)}%</td></tr>`)}</tbody>
</table></div>`;
}

// Voting: the organizer's tab ----------------------------------------------------------------

export interface VotingAdminView {
  event: EventRow;
  settings: VoteSettings | null;
  phase: VotePhase;
  tally: Tally | null;
  clusters: BallotCluster[];
  batches: { batch: string; total: number; used: number }[];
  newCodes?: { batch: string; codes: string[] };
  values?: Record<string, string>;
  errors?: Record<string, string>;
}

export function votingAdminPage(ctx: Ctx, view: VotingAdminView, organizerPage: (body: Renderable, lead: Renderable) => SafeHtml): SafeHtml {
  const { event, settings, phase } = view;
  const v = view.values ?? {};
  const e = view.errors ?? {};
  const slug = event.slug;
  const phaseLabel = { off: 'not set up', upcoming: 'opens later', open: 'open now', closed: 'closed, not published', published: 'published' }[phase];
  return organizerPage(html`
${view.newCodes ? notice('success', html`<p>These ${view.newCodes.codes.length} codes (${view.newCodes.batch}) are shown <strong>once</strong>: only their hashes are stored. Print them now.</p><ol class="code-list">${view.newCodes.codes.map((c) => html`<li><code>${c}</code></li>`)}</ol>`, 'Codes created.') : ''}
<div class="stat-row">
  ${stat('Vote', phaseLabel, settings ? windowText(settings) : 'Set a window below')}
  ${stat('Valid ballots', String(view.tally?.ballots ?? 0), view.tally?.voided ? `${view.tally.voided} voided` : 'none voided')}
  ${stat('Who votes', settings ? (settings.access === 'codes' ? 'Voter codes' : 'Accounts') : '–', settings ? `up to ${settings.max_picks} approval(s) each` : '')}
  ${stat('Flagged clusters', String(view.clusters.length), `${3}+ ballots from one address`)}
</div>
${section('Settings', html`<form method="post" action="/organize/${slug}/voting" class="stack-form">${csrf(ctx)}
  ${formErrors(e)}
  ${input({ name: 'opens_at', label: 'Voting opens (UTC)', type: 'datetime-local', required: true, value: v.opens_at ?? toDatetimeLocal(settings?.opens_at ?? null), error: e.opens_at })}
  ${input({ name: 'closes_at', label: 'Voting closes (UTC)', type: 'datetime-local', required: true, value: v.closes_at ?? toDatetimeLocal(settings?.closes_at ?? null), error: e.closes_at })}
  ${select({ name: 'access', label: 'Who may vote', value: v.access ?? settings?.access ?? 'accounts', error: e.access, options: [
    { value: 'accounts', label: 'Signed-in accounts (not judges or organizers; never their own team)' },
    { value: 'codes', label: 'One-time voter codes printed for the venue' },
  ], hint: 'There is no open-link mode: a link anyone can use cannot be defended against ballot stuffing.' })}
  ${input({ name: 'max_picks', label: 'Projects each ballot may approve', type: 'number', min: 1, max: 10, value: v.max_picks ?? settings?.max_picks ?? 3, error: e.max_picks })}
  <div>${button(settings ? 'Save settings' : 'Set up the vote')}</div>
</form>`, { lead: 'Who may vote and the number of approvals lock once the first ballot is cast.' })}
${settings?.access === 'codes' ? section('Voter codes', html`
  ${view.batches.length ? html`<ul class="row-list">${view.batches.map((b) => html`<li><span>${b.batch}</span><span>${b.used} of ${b.total} used</span></li>`)}</ul>` : html`<p class="muted">No codes yet.</p>`}
  <form method="post" action="/organize/${slug}/voting/codes" class="inline-add">${csrf(ctx)}${input({ name: 'count', label: 'How many new codes', type: 'number', min: 1, max: 500, value: 50, error: e.count })}${button('Create codes', { variant: 'secondary' })}</form>`) : ''}
${view.clusters.length ? section('Ballots to review', html`<p>Several valid ballots came from one address. A venue shares one address, so these are flagged, not refused. Void a ballot only with a reason you would defend; it stays on record.</p>
  ${view.clusters.map((c) => html`<details class="cluster"><summary>Address <code>${c.address}</code>: ${c.ballots.length} ballots${c.sameAgent > 1 ? html` · ${c.sameAgent} from the same browser` : ''}</summary>
    <ul class="row-list">${c.ballots.map((b) => html`<li><span><code>${b.id}</code> ${when(b.cast_at, ctx.now)} · ${b.voter} · browser <code>${b.agent}</code></span>
      ${phase !== 'published' ? html`<form method="post" action="/organize/${slug}/voting/ballots/${b.id}/void" class="inline-add">${csrf(ctx)}${input({ name: 'reason', id: `reason-${b.id}`, label: 'Reason', required: true })}${button('Void', { variant: 'danger', small: true })}</form>` : ''}</li>`)}</ul></details>`)}`) : ''}
${view.tally ? section('Tally', html`${phase === 'published' ? notice('success', 'Published: everyone can see this.') : notice('info', 'Only organizers see this until you publish it.', 'Private.')}${tallyTable(view.tally)}
  ${phase === 'closed' ? actionForm(ctx, `/organize/${slug}/voting/publish`, 'Publish the tally', { variant: 'primary' }) : phase === 'open' || phase === 'upcoming' ? html`<p class="hint">You can publish once voting has closed.</p>` : ''}`) : ''}`,
  html`Community vote: <a href="/events/${slug}/vote">ballot page</a> · <a href="/events/${slug}/vote/results">public results</a>.`);
}

// Comments -------------------------------------------------------------------------------

export function commentsSection(ctx: Ctx, project: ProjectRow, comments: CommentView[], values: { body?: string; error?: string } = {}): SafeHtml {
  return section(`Comments (${comments.filter((c) => !c.hidden_at).length})`, html`
${comments.length ? html`<ol class="comment-list">${comments.map((c) => html`<li class="${cx(c.hidden_at && 'hidden-comment')}" id="${c.id}">
  <div class="comment-meta"><strong>${c.author_name}</strong> · ${when(c.created_at, ctx.now)}${c.hidden_at ? html` ${pill('hidden', 'warn')} <span class="muted">${c.hidden_reason}</span>` : ''}</div>
  <p class="comment-body">${c.body}</p>
  ${c.canHide ? html`<details class="confirm"><summary class="btn btn-ghost btn-sm">${c.author_id === ctx.user?.id ? 'Withdraw' : 'Hide'}</summary><div class="confirm-panel">
    <form method="post" action="/comments/${c.id}/hide">${csrf(ctx)}${c.author_id === ctx.user?.id ? html`<p>Withdraw your comment? It stays on record for the organizers.</p>` : input({ name: 'reason', id: `hide-${c.id}`, label: 'Reason, shown to organizers and in the audit trail', required: true })}${button('Yes, take it down', { variant: 'danger', small: true })}</form>
  </div></details>` : ''}
</li>`)}</ol>` : html`<p class="muted">No comments yet.</p>`}
${ctx.user
  ? html`<form method="post" action="/projects/${project.id}/comments" class="comment-form">${csrf(ctx)}${textarea({ name: 'body', label: 'Add a comment', rows: 3, maxlength: COMMENT_MAX, value: values.body, error: values.error, required: true })}${button('Post comment', { variant: 'secondary' })}</form>`
  : html`<p class="muted"><a href="/login?next=${encodeURIComponent(`/projects/${project.id}`)}">Sign in</a> to comment.</p>`}`,
    { id: 'comments' });
}
