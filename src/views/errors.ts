import type { Ctx } from '../http/context.ts';
import { linkButton } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';

const TITLES: Record<number, string> = {
  400: 'That request did not make sense',
  401: 'Sign in to continue',
  403: 'Not allowed',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'That clashes with something',
  413: 'Too large',
  415: 'Unsupported format',
  422: 'Some fields need attention',
  429: 'Slow down',
  500: 'Something broke',
};

export function errorPage(ctx: Ctx, status: number, message: string, fields?: Record<string, string>): SafeHtml {
  const title = TITLES[status] ?? 'Error';
  return page(ctx, {
    title,
    body: html`<div class="error-page">
      <p class="eyebrow">Error ${status}</p>
      <h1>${title}</h1>
      <p class="lead">${message}</p>
      ${fields ? html`<ul class="error-list">${Object.values(fields).map((f) => html`<li>${f}</li>`)}</ul>` : ''}
      <p class="actions">${linkButton('/', 'Home')} ${status === 401 || status === 403 ? (ctx.user ? '' : linkButton(`/login?next=${encodeURIComponent(ctx.url.pathname)}`, 'Sign in', 'primary')) : linkButton('/projects', 'Browse projects')}</p>
    </div>`,
  });
}
