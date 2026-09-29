import { phaseOf, type EventCounts, type Phase } from '../domain/events.ts';
import type { GalleryItem, ProjectPage, RevisionRow } from '../domain/projects.ts';
import type { CommentView } from '../domain/comments.ts';
import type { ResultsDocument } from '../domain/evidence.ts';
import type { VotePhase } from '../domain/voting.ts';
import { commentsSection } from './community.ts';
import type { PublishedRow, Snapshot } from '../domain/results.ts';
import type { EventRow, PrizeRow, Role, TeamRow, TrackRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { formatDate, formatUtc } from '../util/time.ts';
import { button, confirmForm, csrf, empty, formErrors, input, linkButton, notice, num, pageHeader, pill, section, select, stat, textarea, when } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';

export function phasePill(phase: Phase): SafeHtml {
  const tone = ({ upcoming: 'info', open: 'success', judging: 'warn', 'judging-closed': 'neutral', published: 'dark' } as const)[phase.key];
  return pill(phase.label, tone);
}

// Landing ------------------------------------------------------------------------

export interface LandingData {
  counts: { events: number; projects: number; reviews: number; judges: number };
  featured: EventRow | null;
}

export function landingPage(ctx: Ctx, data: LandingData): SafeHtml {
  const { counts, featured } = data;
  return page(ctx, {
    title: 'From first commit to final verdict',
    surface: 'landing',
    body: html`
<section class="hero">
  <p class="eyebrow">Self-hosted hackathon portal</p>
  <h1>From first commit<br>to final verdict.</h1>
  <p class="hero-lead">Teams submit before a deadline that actually holds. Judges score against a weighted rubric and never see each other’s work. The ranking corrects for harsh and generous judges, and the method is written down.</p>
  <p class="hero-actions">${linkButton('/projects', 'Browse projects', 'primary')} ${featured ? linkButton(`/events/${featured.slug}`, `Open ${featured.name}`, 'ghost') : ''}</p>
  <dl class="hero-stats" aria-label="What this instance holds">
    <div><dt>Events</dt><dd>${counts.events}</dd></div>
    <div><dt>Submitted projects</dt><dd>${counts.projects}</dd></div>
    <div><dt>Submitted reviews</dt><dd>${counts.reviews}</dd></div>
    <div><dt>Judges</dt><dd>${counts.judges}</dd></div>
  </dl>
  <p class="hero-note">Live counts from this instance’s database${ctx.config.demo ? ', which holds the DOGFOOD fixture data' : ''}.</p>
</section>
<section class="features" aria-label="What it does">
  <article><h2>Deadlines that hold</h2><p>Every write checks the server clock inside the same transaction as the write. A late request is refused for being late, by the API as well as the page.</p></article>
  <article><h2>Isolation in the backend</h2><p>A judge’s queries are keyed on their own id. Asking for another judge’s scores returns 403 and lands on the audit trail, whether you use the page or curl.</p></article>
  <article><h2>Judging you can defend</h2><p>Additive judge offsets with ridge shrinkage, chosen by simulation on the fixture’s own judge layout. Raw means sit beside normalized scores, always.</p></article>
  <article><h2>One command, no cloud</h2><p><code>docker compose up</code> starts a seeded portal with the network off. Node’s standard library and SQLite: zero runtime dependencies.</p></article>
</section>
<section class="method-teaser">
  <div>
    <p class="eyebrow">The ranking, in one line</p>
    <p class="formula">score<sub>jp</sub> = μ + a<sub>p</sub> + b<sub>j</sub> + ε,&nbsp; rank by μ + a<sub>p</sub></p>
    <p>Each judge’s offset b<sub>j</sub> is shrunk toward zero as if they had filed two extra unbiased reviews, so one harsh review cannot brand a judge. <a href="/about#normalization">Read the method and the evidence</a>.</p>
  </div>
</section>`,
  });
}

// Gallery ------------------------------------------------------------------------

export interface GalleryView {
  items: GalleryItem[];
  total: number;
  page: number;
  pages: number;
  events: EventRow[];
  tracks: (TrackRow & { event_name: string })[];
  query: { q: string; event: string; track: string; sort: string };
}

export function galleryPage(ctx: Ctx, view: GalleryView): SafeHtml {
  const { query } = view;
  const filtered = Boolean(query.q || query.event || query.track);
  const params = (pageNumber: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
    if (pageNumber > 1) search.set('page', String(pageNumber));
    return `/projects${search.size ? `?${search}` : ''}`;
  };
  return page(ctx, {
    title: 'Projects',
    nav: 'projects',
    wide: true,
    body: html`
${pageHeader('Projects', { eyebrow: 'Public gallery', lead: `${view.total} submitted project${view.total === 1 ? '' : 's'}${filtered ? ' match these filters' : ` across ${view.events.length} event${view.events.length === 1 ? '' : 's'}`}. Drafts stay private until their team submits.` })}
<form class="filters" method="get" action="/projects" role="search">
  ${input({ name: 'q', label: 'Search', type: 'search', value: query.q, placeholder: 'Title, summary or team' })}
  ${select({ name: 'event', label: 'Event', value: query.event, blank: 'All events', options: view.events.map((e) => ({ value: e.slug, label: e.name })) })}
  ${select({ name: 'track', label: 'Track', value: query.track, blank: 'All tracks', options: view.tracks.map((t) => ({ value: t.id, label: view.events.length > 1 ? `${t.name} (${t.event_name})` : t.name })) })}
  ${select({ name: 'sort', label: 'Order', value: query.sort, options: [{ value: 'oldest', label: 'First submitted' }, { value: 'newest', label: 'Latest submitted' }, { value: 'title', label: 'Title A–Z' }] })}
  <div class="filter-actions">${button('Apply')} ${filtered ? html`<a class="btn btn-ghost" href="/projects">Clear</a>` : ''}</div>
</form>
${view.items.length === 0
  ? empty('No projects found', filtered ? 'Nothing matches these filters. Try a shorter search or another track.' : 'No project has been submitted yet.')
  : html`<ul class="card-grid" aria-label="Projects">${view.items.map((p) => projectCard(p))}</ul>`}
${view.pages > 1
  ? html`<nav class="pager" aria-label="Pages">${view.page > 1 ? html`<a href="${params(view.page - 1)}" rel="prev">Previous</a>` : html`<span></span>`}<span>Page ${view.page} of ${view.pages}</span>${view.page < view.pages ? html`<a href="${params(view.page + 1)}" rel="next">Next</a>` : html`<span></span>`}</nav>`
  : ''}`,
  });
}

function projectCard(p: GalleryItem): SafeHtml {
  return html`<li class="card project-card">
    <div class="card-top">
      ${p.track_name ? pill(p.track_name, 'neutral') : ''}
      ${p.rank !== null ? pill(`Rank ${p.rank}`, 'dark') : ''}
    </div>
    <h2 class="card-title"><a href="/projects/${p.id}">${p.title}</a></h2>
    <p class="card-summary">${p.summary || html`<span class="muted">No summary.</span>`}</p>
    <p class="card-meta"><span>${p.team_name}</span><span aria-hidden="true">·</span><span>${p.event_name}</span></p>
    <p class="card-meta muted">Submitted ${p.submitted_at ? formatDate(p.submitted_at) : ''}</p>
  </li>`;
}

// Project page -------------------------------------------------------------------

export function projectDetailPage(ctx: Ctx, view: ProjectPage, revisions: RevisionRow[] | null, comments: CommentView[] | null = null): SafeHtml {
  const { project, event, team, track, members } = view;
  const links = [
    ['Repository', project.repo_url],
    ['Demo', project.demo_url],
    ['Video', project.video_url],
  ].filter(([, url]) => url);
  const status = project.superseded_by
    ? notice('warn', html`This submission was replaced by a later one from the same team, <a href="/projects/${project.superseded_by}">${view.supersededBy?.title}</a> (${project.superseded_by}). It is kept on record but is not judged or shown in the gallery.`, 'Replaced.')
    : project.status === 'draft'
      ? notice('info', html`Only your team and the organizers can see this. Submit it before ${formatUtc(event.submissions_close_at)} to enter.`, 'Draft.')
      : project.status === 'withdrawn'
        ? notice('warn', 'The team withdrew this project. It is not public and will not be judged.', 'Withdrawn.')
        : '';
  return page(ctx, {
    title: project.title,
    nav: 'projects',
    body: html`
${pageHeader(project.title, {
  eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>${track ? html` · ${track.name}` : ''}`,
  lead: project.summary,
  actions: html`${view.canEdit ? linkButton(`/projects/${project.id}/edit`, project.status === 'draft' ? 'Edit draft' : 'Edit project', 'primary') : ''}${view.isOrganizer ? linkButton(`/organize/${event.slug}/projects`, 'Organizer view') : ''}`,
})}
${status}
${view.supersedes.length ? notice('info', html`This is the submission that counts for ${team.name}. It replaced ${view.supersedes.map((s) => s.id).join(', ')}, which stays on record.`) : ''}
<div class="two-col">
  <div>
    ${section('About the project', project.description ? html`<div class="prose">${project.description}</div>` : html`<p class="muted">The team has not written a description.</p>`)}
    ${links.length ? section('Links', html`<ul class="link-list">${links.map(([label, url]) => html`<li><span>${label}</span> <a href="${url}" rel="nofollow noopener ugc">${url}</a></li>`)}</ul>`) : ''}
    ${comments ? commentsSection(ctx, project, comments) : ''}
  </div>
  <aside>
    ${section('Team', html`<p class="team-name">${team.name}</p><ul class="plain-list">${members.map((m) => html`<li>${m.name}${m.is_captain ? html` <span class="muted">(captain)</span>` : ''}</li>`)}</ul>`)}
    ${section('Record', html`<dl class="facts">
      <div><dt>Status</dt><dd>${project.superseded_by ? 'Replaced' : project.status === 'submitted' ? 'Submitted' : project.status === 'draft' ? 'Draft' : 'Withdrawn'}</dd></div>
      <div><dt>Submitted</dt><dd>${when(project.submitted_at, ctx.now)}</dd></div>
      <div><dt>Last change</dt><dd>${when(project.updated_at, ctx.now)}</dd></div>
      <div><dt>Deadline</dt><dd>${when(event.submissions_close_at, ctx.now)}</dd></div>
      <div><dt>Id</dt><dd><code>${project.id}</code></dd></div>
    </dl>`)}
    ${view.canEdit && project.status !== 'withdrawn' ? confirmForm(ctx, `/projects/${project.id}/withdraw`, 'Withdraw project', 'The project leaves the gallery and will not be judged. You can start a new one before the deadline.', 'Yes, withdraw', 'danger') : ''}
  </aside>
</div>
${revisions ? section('Revision history', html`<ol class="timeline">${revisions.map((r) => html`<li><span class="pill pill-neutral">v${r.version}</span> ${r.action} by ${r.actor_name ?? 'import'} · ${when(r.at, ctx.now)}</li>`)}</ol>`, { lead: 'Every save is kept. This is what settles “what did we have at the deadline?”' }) : ''}`,
  });
}

// Project form ---------------------------------------------------------------------

export interface ProjectFormView {
  event: EventRow;
  team: TeamRow;
  tracks: TrackRow[];
  values: Record<string, string>;
  errors?: Record<string, string>;
  projectId?: string;
  status?: string;
  version?: number;
}

export function projectFormPage(ctx: Ctx, view: ProjectFormView): SafeHtml {
  const editing = Boolean(view.projectId);
  const v = view.values;
  const e = view.errors ?? {};
  const action = editing ? `/projects/${view.projectId}/edit` : `/projects/new?event=${view.event.slug}`;
  return page(ctx, {
    title: editing ? `Edit ${v.title ?? 'project'}` : 'New project',
    nav: 'dashboard',
    body: html`
${pageHeader(editing ? `Edit “${v.title}”` : 'Start your project', { eyebrow: html`${view.event.name} · ${view.team.name}`, lead: html`Submissions close ${when(view.event.submissions_close_at, ctx.now)}. You can edit until then; after that the server refuses every change.` })}
${formErrors(e)}
<form method="post" action="${action}" class="form-card" novalidate>
  ${csrf(ctx)}
  ${editing ? html`<input type="hidden" name="version" value="${view.version}">` : ''}
  ${input({ name: 'title', label: 'Title', value: v.title, required: true, maxlength: 120, error: e.title })}
  ${input({ name: 'summary', label: 'One-line summary', value: v.summary, maxlength: 280, error: e.summary, hint: 'Shown in the gallery. Required to submit.' })}
  ${view.tracks.length ? select({ name: 'track_id', label: 'Track', value: v.track_id, blank: 'Choose a track', options: view.tracks.map((t) => ({ value: t.id, label: t.name })), error: e.track_id, hint: 'Judges are assigned by track. Required to submit.' }) : ''}
  ${textarea({ name: 'description', label: 'Description', value: v.description, rows: 8, maxlength: 10000, error: e.description, hint: 'What it does, how it works, what you would do next. Plain text.' })}
  <div class="grid-2">
    ${input({ name: 'repo_url', label: 'Repository URL', type: 'url', value: v.repo_url, error: e.repo_url, placeholder: 'https://…' })}
    ${input({ name: 'demo_url', label: 'Demo URL', type: 'url', value: v.demo_url, error: e.demo_url, placeholder: 'https://…' })}
  </div>
  ${input({ name: 'video_url', label: 'Video URL', type: 'url', value: v.video_url, error: e.video_url, placeholder: 'https://…' })}
  <p class="hint">To submit you need a summary${view.tracks.length ? ', a track' : ''} and a repository or demo link. A draft can be incomplete.</p>
  <div class="form-actions">
    ${view.status === 'submitted'
      ? button('Save changes')
      : html`${button('Save draft', { variant: 'secondary', name: 'intent', value: 'draft' })} ${button('Submit project', { name: 'intent', value: 'submit' })}`}
    <a class="btn btn-ghost" href="${editing ? `/projects/${view.projectId}` : `/events/${view.event.slug}/team`}">Cancel</a>
  </div>
</form>`,
  });
}

// Events ---------------------------------------------------------------------------

export function eventsPage(ctx: Ctx, events: (EventRow & EventCounts)[], canCreate: boolean): SafeHtml {
  return page(ctx, {
    title: 'Events',
    nav: 'events',
    body: html`
${pageHeader('Events', { lead: 'Every hackathon on this instance, newest deadline first.', actions: canCreate ? linkButton('/events/new', 'Create an event', 'primary') : '' })}
${events.length === 0
  ? empty('No events yet', canCreate ? 'Create the first one.' : 'An administrator has not created an event yet.')
  : html`<ul class="event-list">${events.map((e) => html`<li class="card event-card">
      <div class="card-top">${phasePill(phaseOf(e, ctx.now))}</div>
      <h2 class="card-title"><a href="/events/${e.slug}">${e.name}</a></h2>
      ${e.tagline ? html`<p class="card-summary">${e.tagline}</p>` : ''}
      <p class="card-meta">Deadline ${when(e.submissions_close_at, ctx.now)}</p>
      <p class="card-meta muted">${e.submitted} submitted · ${e.teams} teams · ${e.judges} judges</p>
    </li>`)}</ul>`}`,
  });
}

export interface EventPageView {
  event: EventRow;
  tracks: TrackRow[];
  prizes: (PrizeRow & { track_name: string | null })[];
  counts: EventCounts;
  roles: Set<Role>;
  team: TeamRow | null;
  published: boolean;
  vote?: VotePhase;
}

export function eventPage(ctx: Ctx, view: EventPageView): SafeHtml {
  const { event, roles } = view;
  const phase = phaseOf(event, ctx.now);
  const cta: SafeHtml[] = [];
  if (roles.has('organizer')) cta.push(linkButton(`/organize/${event.slug}`, 'Organizer console', 'primary'));
  if (roles.has('judge')) cta.push(linkButton(`/judge/${event.slug}`, 'Your judging queue', 'primary'));
  if (view.team) cta.push(linkButton(`/events/${event.slug}/team`, `Your team: ${view.team.name}`, roles.has('organizer') || roles.has('judge') ? 'secondary' : 'primary'));
  else if (phase.key === 'open' && !roles.has('judge') && !roles.has('organizer')) cta.push(linkButton(ctx.user ? `/events/${event.slug}/team` : `/signup?next=/events/${event.slug}/team`, 'Join or start a team', 'primary'));
  if (view.published) cta.push(linkButton(`/events/${event.slug}/results`, 'Results', 'secondary'));
  if (view.vote === 'open') cta.push(linkButton(`/events/${event.slug}/vote`, 'Vote for your favourites', roles.size ? 'secondary' : 'primary'));
  if (view.vote === 'published') cta.push(linkButton(`/events/${event.slug}/vote/results`, 'Community vote', 'secondary'));
  cta.push(linkButton(`/projects?event=${event.slug}`, 'Projects', 'secondary'));

  return page(ctx, {
    title: event.name,
    nav: 'events',
    body: html`
${pageHeader(event.name, { eyebrow: phasePill(phase), lead: event.tagline, actions: cta })}
<div class="stat-row">
  ${stat('Submissions close', html`<time datetime="${event.submissions_close_at}">${formatUtc(event.submissions_close_at)}</time>`, when(event.submissions_close_at, ctx.now, { relative: true }))}
  ${stat('Submitted', String(view.counts.submitted), `${view.counts.teams} teams`)}
  ${stat('Judges', String(view.counts.judges), `${event.reviews_per_project} reviews per project`)}
  ${stat('Team size', `up to ${event.max_team_size}`)}
</div>
<div class="two-col">
  <div>
    ${event.description ? section('About', html`<div class="prose">${event.description}</div>`) : ''}
    ${section('Tracks', view.tracks.length ? html`<ul class="track-list">${view.tracks.map((t) => html`<li><a href="/projects?event=${event.slug}&amp;track=${t.id}">${t.name}</a>${t.description ? html` <span class="muted">${t.description}</span>` : ''}</li>`)}</ul>` : html`<p class="muted">This event has no tracks.</p>`)}
    ${section('Prizes', view.prizes.length ? html`<ul class="prize-list">${view.prizes.map((p) => html`<li><strong>${p.name}</strong>${p.track_name ? html` <span class="pill pill-neutral">${p.track_name}</span>` : html` <span class="pill pill-neutral">Overall</span>`}${p.description ? html`<br><span class="muted">${p.description}</span>` : ''}</li>`)}</ul>` : html`<p class="muted">No prizes are listed.</p>`)}
  </div>
  <aside>
    ${section('Timeline', html`<ol class="timeline">
      <li><strong>Submissions open</strong><br>${event.submissions_open_at ? when(event.submissions_open_at, ctx.now) : html`<span class="muted">from creation</span>`}</li>
      <li><strong>Deadline</strong><br>${when(event.submissions_close_at, ctx.now)}</li>
      <li><strong>Judging closes</strong><br>${event.judging_close_at ? when(event.judging_close_at, ctx.now) : html`<span class="muted">when results are published</span>`}</li>
      <li><strong>Results</strong><br>${event.results_published_at ? when(event.results_published_at, ctx.now) : html`<span class="muted">not published yet</span>`}</li>
    </ol>`)}
  </aside>
</div>`,
  });
}

export function resultsPage(ctx: Ctx, event: EventRow, published: { snapshot: Snapshot; rows: PublishedRow[] } | null, isOrganizer: boolean, evidence: { signed: boolean; document: ResultsDocument } | null = null): SafeHtml {
  const intervals = Boolean(published?.rows.some((r) => r.rank_lo !== null));
  return page(ctx, {
    title: `Results · ${event.name}`,
    nav: 'events',
    body: html`
${pageHeader('Results', { eyebrow: html`<a href="/events/${event.slug}">${event.name}</a>`, lead: published ? html`Published ${when(published.snapshot.published_at, ctx.now)} from ${published.snapshot.review_count} reviews.` : 'Results are hidden until the organizers publish them.' })}
${!published
  ? html`${empty('Not published yet', 'Rankings stay private while judging is under way, so no one can read an early lead into the scores.')}${isOrganizer ? html`<p>${linkButton(`/organize/${event.slug}/results`, 'Preview and publish', 'primary')}</p>` : ''}`
  : html`
<div class="table-wrap"><table class="data">
  <caption class="sr-only">Final ranking</caption>
  <thead><tr><th scope="col">Rank</th><th scope="col">Project</th><th scope="col">Team</th><th scope="col">Track</th><th scope="col" class="n">Score</th><th scope="col" class="n">Raw mean</th>${intervals ? html`<th scope="col" class="n">Likely place (90%)</th>` : ''}<th scope="col" class="n">Reviews</th></tr></thead>
  <tbody>${published.rows.map((r) => html`<tr${r.rank <= 3 ? html` class="podium"` : ''}>
    <td class="rank">${r.rank}</td><td><a href="/projects/${r.project_id}">${r.title}</a>${r.low_coverage ? html` ${pill('few reviews', 'warn')}` : ''}</td><td>${r.team_name}</td><td>${r.track_name ?? ''}</td>
    <td class="n">${num(r.score, 3)}</td><td class="n">${num(r.raw_mean, 3)}</td>${intervals ? html`<td class="n">${r.rank_lo === null || r.rank_hi === null ? '–' : r.rank_lo === r.rank_hi ? String(r.rank_lo) : `${r.rank_lo}–${r.rank_hi}`}</td>` : ''}<td class="n">${r.review_count}</td></tr>`)}</tbody>
</table></div>
${section('How these scores were computed', html`<p><strong>Score</strong> is the project’s average after removing each judge’s fitted offset (method <code>${published.snapshot.method}</code>, shrinkage λ = ${published.snapshot.lambda}). <strong>Raw mean</strong> is the plain average of its reviews. Both are on the event’s ${event.score_min}–${event.score_max} scale, from the weighted rubric.${intervals ? html` <strong>Likely place</strong> is the range the project lands in across 90% of simulated re-runs of the judging with the same judges and noise: overlapping ranges are too close to call.` : ''} <a href="/about#normalization">Full method</a>.</p>`)}
${evidence ? verifySection(event, evidence) : ''}`}`,
  });
}

function verifySection(event: EventRow, evidence: { signed: boolean; document: ResultsDocument }): SafeHtml {
  const doc = evidence.document;
  const c = doc.certainty;
  const commitment = doc.method.commitment;
  return section('Check these results yourself', html`<ul class="row-list">
  <li><span>${evidence.signed ? pill('signature valid', 'success') : pill('signature invalid', 'danger')} Signed with Ed25519 when published. The signed document quotes every score and rank above, the weights, and the audit trail's head at that moment (#${doc.audit_anchor?.id ?? '–'}).</span></li>
  <li><span>${commitment ? (commitment.unchanged ? pill('method unchanged', 'success') : pill('method changed', 'warn')) : pill('not recorded', 'neutral')} ${commitment ? (commitment.unchanged ? html`The method and weights were fixed ${formatUtc(commitment.committed_at)}, when the first score arrived, and were not changed before publication.` : html`The method or weights changed after scoring began (${commitment.later_rubric_edits} rubric edit(s)); the organizer's audit trail records each one.`) : 'No method commitment was recorded for this event.'}</span></li>
  ${c ? html`<li><span>${pill(`${c.winner_holds} of ${c.refits}`, c.winner_holds === c.refits ? 'success' : 'info')} First place survives removing any one judge in ${c.winner_holds} of ${c.refits} refits; the podium in ${c.podium_holds} of ${c.refits}.</span></li>` : ''}
</ul>
<p>${linkButton(`/events/${event.slug}/results.json`, 'Signed results (JSON)', 'secondary')} Check it offline with <code>node src/cli.ts verify-results results.json</code>. The organizers can also share a results capsule: one HTML file that checks its own signature and refits the ranking in any browser.</p>`);
}

// About ------------------------------------------------------------------------------

export function aboutPage(ctx: Ctx): SafeHtml {
  return page(ctx, {
    title: 'About and methods',
    body: html`
${pageHeader('How Forgeboard works', { eyebrow: 'About and methods', lead: 'What each role can see, how the ranking is computed, and what this instance is.' })}
<div class="prose-page">
<h2 id="roles">Roles</h2>
<p>Roles belong to an event, not to an account: the same person can judge one hackathon and compete in another. <strong>Visitors</strong> browse the gallery and published results. <strong>Participants</strong> form a team with an invite link and submit one project per team. <strong>Judges</strong> see only the projects assigned to them and only their own scores. <strong>Organizers</strong> configure the event, the rubric and the judges, watch progress, and publish. <strong>Administrators</strong> create events and manage accounts. A judge cannot be on a team in the same event, and an organizer cannot judge it.</p>
<h2 id="isolation">Isolation</h2>
<p>Every rule above is enforced on the server. Pages and the JSON API go through the same checks, so hiding a button is never the only thing standing in the way. A refused attempt returns 403 and is written to the event’s audit trail with who tried what.</p>
<h2 id="normalization">How the ranking is computed</h2>
<p>Each review becomes one number: the weighted average of its criterion scores, using the organizer’s weights. Judges differ in how generously they score, so a project’s raw average depends on who happened to review it. Forgeboard fits one model to all reviews at once:</p>
<p class="formula">x<sub>jp</sub> = μ + a<sub>p</sub> + b<sub>j</sub> + ε</p>
<p>μ is the overall mean, a<sub>p</sub> the project’s effect and b<sub>j</sub> the judge’s offset. The offsets are shrunk toward zero with λ = 2: a judge counts as if they had filed two extra reviews with no bias, so a judge seen once or twice is not declared harsh on thin evidence. Projects are ranked by μ + a<sub>p</sub>. The raw mean is always shown beside it.</p>
<p>This method was chosen by simulation on the fixture’s real judge–project layout, where it recovered the true ranking better than raw means and better than per-judge z-scores (which need more reviews per judge than a hackathon produces). The full derivation, the evidence and the limits are in <code>JUDGING.md</code> in the repository.</p>
<h2 id="edge-cases">Awkward cases</h2>
<ul>
<li><strong>A judge who gives everyone the same score</strong> is flagged “no variation” for the organizer. Their reviews still count, and their generosity or harshness is absorbed by their offset.</li>
<li><strong>Unfinished batches</strong> show up as uneven coverage. Nothing assumes every judge reviewed every project; a project with fewer than two reviews is ranked but flagged.</li>
<li><strong>A duplicate submission</strong> from one team: the latest counts, the earlier one is kept on record as replaced, and the organizer can reverse the choice. Nothing is merged or deleted silently.</li>
</ul>
<h2 id="demo">Demo mode</h2>
${ctx.config.demo
  ? html`<p>This instance runs in <strong>demo mode</strong>. It was seeded from the DOGFOOD <code>fixtures.json</code> and has five demo accounts whose password is published in the README, plus four fixed session tokens used by the acceptance checker. That makes it easy to evaluate and unsafe for real data: an operator turns demo mode off by leaving <code>FORGEBOARD_DEMO</code> unset.</p>`
  : html`<p>Demo mode is off on this instance.</p>`}
<h2 id="self-hosting">Self-hosting</h2>
<p>One container, one SQLite file, no network access needed. <code>docker compose up</code> starts it; every table is documented in <code>DATA-MODEL.md</code>, and every judging stage exports to CSV so leaving is as easy as arriving.</p>
</div>`,
  });
}
