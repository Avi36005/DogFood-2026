import type { Ctx } from '../http/context.ts';
import { WEBHOOK_EVENTS } from '../domain/outbox.ts';
import type { EventRow } from '../domain/types.ts';
import type { Delivery, Webhook } from '../domain/webhooks.ts';
import { MAX_ATTEMPTS } from '../domain/webhooks.ts';
import { actionForm, button, checkboxes, confirmForm, csrf, empty, formErrors, input, pill, section, when } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { organizerPage } from './organize.ts';

const LABELS: Record<string, string> = {
  'project.submitted': 'A project is submitted',
  'project.withdrawn': 'A project is withdrawn',
  'event.submissions_closed': 'Submissions close',
  'review.submitted': 'A judge submits a review (ids only, never scores)',
  'results.published': 'Results are published',
  'results.withdrawn': 'Results are taken down',
  'vote.published': 'The community vote is published',
};

export function webhooksPage(ctx: Ctx, event: EventRow, hooks: Webhook[], deliveries: Delivery[], form: { values?: Record<string, unknown>; errors?: Record<string, string> } = {}): SafeHtml {
  const errors = form.errors ?? {};
  const chosen = Array.isArray(form.values?.events) ? (form.values?.events as string[]) : typeof form.values?.events === 'string' ? [form.values.events as string] : [];
  const statusPill = (d: Delivery) => (d.status === 'delivered' ? pill('delivered', 'success') : d.status === 'failed' ? pill('failed', 'danger') : pill(d.attempts ? `retrying (${d.attempts}/${MAX_ATTEMPTS})` : 'queued', 'warn'));
  return organizerPage(
    ctx,
    event,
    'webhooks',
    'Webhooks',
    html`
${section(
  'Your webhooks',
  hooks.length
    ? html`<table class="table"><thead><tr><th>URL and events</th><th>Signing secret</th><th>Deliveries</th><th></th></tr></thead><tbody>${hooks.map(
        (h) => html`<tr>
      <td><code>${h.url}</code><br><span class="muted">${h.events.join(', ')}</span></td>
      <td><code class="secret">${h.secret}</code></td>
      <td>${h.delivered} delivered · ${h.pending} pending · ${h.failed} failed</td>
      <td>${actionForm(ctx, `/organize/${event.slug}/webhooks/${h.id}/ping`, 'Send a test ping', { small: true })} ${confirmForm(ctx, `/organize/${event.slug}/webhooks/${h.id}/remove`, 'Remove', 'Nothing more is sent to it. Its delivery history stays.', 'Yes, remove', 'danger')}</td>
    </tr>`,
      )}</tbody></table>`
    : empty('No webhooks yet', 'Add one below to tell another system when something happens in this event.'),
)}
${section(
  'Add a webhook',
  html`<form method="post" action="/organize/${event.slug}/webhooks" class="stack">${csrf(ctx)}${formErrors(errors)}
    ${input({ name: 'url', label: 'URL', type: 'url', required: true, value: typeof form.values?.url === 'string' ? form.values.url : '', placeholder: 'https://example.org/hooks/forgeboard', error: errors.url, hint: 'We POST JSON here. Anything your server can reach works, including a machine on your own network.' })}
    ${checkboxes({ name: 'events', label: 'Send these events', values: chosen, options: WEBHOOK_EVENTS.map((e) => ({ value: e, label: LABELS[e] ?? e })), error: errors.events })}
    ${button('Add webhook', { variant: 'primary' })}
  </form>`,
)}
${section(
  'Recent deliveries',
  deliveries.length
    ? html`<table class="table"><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Last response</th></tr></thead><tbody>${deliveries.map(
        (d) => html`<tr><td>${when(d.created_at, ctx.now, { relative: true })}</td><td><code>${d.type}</code></td><td>${statusPill(d)}</td><td>${d.last_status ?? ''}${d.last_error ? html` <span class="muted">${d.last_error}</span>` : ''}${d.status === 'pending' && d.attempts ? html`<br><span class="muted">next try ${when(d.next_attempt_at, ctx.now, { relative: true })}</span>` : ''}</td></tr>`,
      )}</tbody></table>`
    : html`<p class="muted">Nothing sent yet.</p>`,
)}
${section(
  'Checking a delivery',
  html`<p>Each request carries <code>Forgeboard-Event</code>, <code>Forgeboard-Delivery</code> and <code>Forgeboard-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where <code>v1</code> is HMAC-SHA256 with the secret above over <code>&lt;t&gt;.&lt;raw body&gt;</code>. Recompute it, compare, and refuse a <code>t</code> more than five minutes old. The body names the audit entry (id and hash) it reports, so you can match it to the tamper-evident trail.</p>
  <p>Deliveries are queued in the same database transaction as the change they report, so a change that fails never fires, and a restart loses nothing. Failed deliveries retry after 30 s, 1, 2, 4 and 8 minutes, then stop.</p>`,
)}`,
    { lead: 'Tell another system, such as a chat bot, a scoreboard or a spreadsheet, the moment something happens.' },
  );
}
