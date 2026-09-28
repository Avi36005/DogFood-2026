import { phaseOf, type EventCounts, type Phase } from '../domain/events.ts';
import type { GalleryItem, ProjectPage, RevisionRow } from '../domain/projects.ts';
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

export function projectDetailPage(ctx: Ctx, view: ProjectPage, revisions: RevisionRow[] | null): SafeHtml {
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

