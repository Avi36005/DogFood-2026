import { myEventRoles } from '../domain/access.ts';
import type { EventRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { asset } from './assets.ts';
import { csrf, notice } from './components.ts';
import { cx, html, type Renderable, type SafeHtml } from './html.ts';

export interface PageOptions {
  title: string;
  body: Renderable;
  /** 'landing' draws the dark hero surface; everything else is the light working surface. */
  surface?: 'landing' | 'app';
  /** Marks the matching top-level navigation item as current. */
  nav?: 'projects' | 'events' | 'dashboard' | 'judge' | 'organize' | 'admin' | 'account';
  wide?: boolean;
}

function navLink(href: string, label: string, current: boolean): SafeHtml {
  return html`<a href="${href}"${current ? html` aria-current="page"` : ''}>${label}</a>`;
}

export function page(ctx: Ctx, options: PageOptions): SafeHtml {
  const user = ctx.user;
  const roles = user ? myEventRoles(ctx.store, user.id) : [];
  const judges = roles.some((r) => r.roles.has('judge'));
  const organizes = roles.some((r) => r.roles.has('organizer')) || Boolean(user?.is_admin);
  const flash = ctx.takeFlash();
  // On the sign-in and sign-up pages, keep the existing destination instead of nesting ?next=.
  const onAuthPage = /^\/(login|signup)$/.test(ctx.url.pathname);
  const returnTo = onAuthPage ? ctx.safeNext('/dashboard') : ctx.url.pathname + ctx.url.search;
  const surface = options.surface ?? 'app';

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} · Forgeboard</title>
<meta name="description" content="Forgeboard: a self-hosted hackathon submission and judging portal.">
<link rel="icon" href="${asset('favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${asset('app.css')}">
<script src="${asset('app.js')}" defer></script>
</head>
<body class="${cx(`surface-${surface}`)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>Forgeboard</a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav id="site-nav" class="site-nav" aria-label="Main">
      <div class="nav-main">
        ${surface === 'landing' && !user
          ? html`<a href="/#platform">Platform</a><a href="/#how-it-works">How it works</a><a href="/#judging">Judging</a><a href="/about">Open source</a>`
          : ''}
        ${surface === 'landing' && !user ? '' : navLink('/projects', 'Projects', options.nav === 'projects')}
        ${surface === 'landing' && !user ? '' : navLink('/events', 'Events', options.nav === 'events')}
        ${user ? navLink('/dashboard', 'Dashboard', options.nav === 'dashboard') : ''}
        ${judges ? navLink('/judge', 'Judging', options.nav === 'judge') : ''}
        ${organizes ? navLink('/organize', 'Organize', options.nav === 'organize') : ''}
        ${user?.is_admin ? navLink('/admin', 'Admin', options.nav === 'admin') : ''}
      </div>
      <div class="nav-user">
        ${user
          ? html`<a class="nav-me" href="/account"${options.nav === 'account' ? html` aria-current="page"` : ''}>${user.name}</a>
             <form method="post" action="/logout" class="inline-form">${csrf(ctx)}<button class="link-button" type="submit">Sign out</button></form>`
          : html`<a href="/login?next=${encodeURIComponent(returnTo)}">Sign in</a>${surface === 'landing'
              ? html`<a class="btn btn-accent btn-sm" href="/events/new">Create an event</a>`
              : html`<a class="btn btn-accent btn-sm" href="/signup?next=${encodeURIComponent(returnTo)}">Create account</a>`}`}
      </div>
    </nav>
  </div>
</header>
${ctx.config.demo ? html`<div class="demo-banner" role="note">Demo instance: seeded from the DOGFOOD fixtures with published demo sign-ins. <a href="/about#demo">What that means</a></div>` : ''}
<main id="main" class="${cx('container', options.wide && 'container-wide')}">
${flash ? html`<div class="flash">${notice(flash.kind === 'error' ? 'error' : flash.kind === 'success' ? 'success' : 'info', flash.text)}</div>` : ''}
${options.body}
</main>
<footer class="footer">
  <div class="${cx('container', options.wide && 'container-wide', 'footer-inner')}">
    <p><strong>Forgeboard</strong>: open source (MIT), self-hosted, runs offline. From first commit to final verdict.</p>
    <p class="footer-links"><a href="/about">About &amp; methods</a><a href="/projects">Gallery</a><a href="/api">API</a><a href="/healthz">Health</a></p>
  </div>
</footer>
</body>
</html>`;
}

/** The organizer's section navigation, shared by every /organize/:slug page. */
export function organizerTabs(event: EventRow, current: string): SafeHtml {
  const tabs: [string, string][] = [
    ['', 'Overview'],
    ['settings', 'Event'],
    ['rubric', 'Rubric'],
    ['judges', 'Judges'],
    ['assignments', 'Assignments'],
    ['projects', 'Projects'],
    ['results', 'Results'],
    ['voting', 'Community vote'],
    ['audit', 'Audit trail'],
    ['webhooks', 'Webhooks'],
    ['export', 'Export'],
  ];
  return html`<nav class="tabs" aria-label="Organizer sections">
    ${tabs.map(([path, label]) => html`<a href="/organize/${event.slug}${path ? `/${path}` : ''}"${current === path ? html` aria-current="page"` : ''}>${label}</a>`)}
  </nav>`;
}
