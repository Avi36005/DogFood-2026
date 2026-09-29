import type { GalleryItem } from '../domain/projects.ts';
import type { PublishedRow } from '../domain/results.ts';
import type { EventRow } from '../domain/types.ts';
import { asset } from './assets.ts';
import { html, type SafeHtml } from './html.ts';

/**
 * The embeddable widget (T4): an event's public gallery, or its published results, with no site
 * chrome, for an <iframe> on someone else's page. It shows only what the public pages show; links
 * open the full page in a new tab. Served with frame-ancestors * (every other page forbids framing).
 */
export function embedPage(options: {
  event: EventRow;
  view: 'gallery' | 'results';
  projects: GalleryItem[];
  total: number;
  results: PublishedRow[] | null;
  base: string;
}): SafeHtml {
  const { event, view, projects, total, results, base } = options;
  const link = (path: string) => `${base}${path}`;
  const body =
    view === 'results'
      ? results
        ? html`<ol class="embed-results">${results.map((r) => html`<li${r.rank <= 3 ? html` class="podium"` : ''}><span class="rank">${r.rank}</span> <a href="${link(`/projects/${r.project_id}`)}" target="_blank" rel="noopener">${r.title}</a> <span class="muted">${r.team_name}</span></li>`)}</ol>`
        : html`<p class="muted">Results are hidden until the organizers publish them.</p>`
      : html`<ul class="embed-gallery">${projects.map((p) => html`<li><a href="${link(`/projects/${p.id}`)}" target="_blank" rel="noopener"><strong>${p.title}</strong></a><br><span class="muted">${p.team_name}${p.track_name ? html` · ${p.track_name}` : ''}</span></li>`)}</ul>${total > projects.length ? html`<p class="muted">${projects.length} of ${total}. <a href="${link(`/projects?event=${event.slug}`)}" target="_blank" rel="noopener">See all</a></p>` : ''}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${event.name}: ${view === 'results' ? 'results' : 'projects'}</title>
<link rel="stylesheet" href="${asset('app.css')}">
</head>
<body class="embed">
<main class="embed-body">
<p class="embed-head"><a href="${link(`/events/${event.slug}`)}" target="_blank" rel="noopener">${event.name}</a> · ${view === 'results' ? 'results' : `${total} project${total === 1 ? '' : 's'}`}</p>
${body}
<p class="embed-foot muted">Forgeboard</p>
</main>
</body>
</html>`;
}

/** The snippet an organizer copies. */
export function embedSnippet(base: string, slug: string, view: 'gallery' | 'results'): string {
  return `<iframe src="${base}/embed/${slug}${view === 'results' ? '?view=results' : ''}" title="${view === 'results' ? 'Results' : 'Projects'}" width="100%" height="480" style="border:0" loading="lazy"></iframe>`;
}
