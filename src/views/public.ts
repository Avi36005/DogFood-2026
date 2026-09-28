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

