import type { UserListRow } from '../domain/admin.ts';
import { phaseOf } from '../domain/events.ts';
import type { EventRow } from '../domain/types.ts';
import type { Ctx } from '../http/context.ts';
import { actionForm, button, csrf, formErrors, input, linkButton, notice, pageHeader, pill, section } from './components.ts';
import { html, type SafeHtml } from './html.ts';
import { page } from './layout.ts';
import { phasePill } from './public.ts';

export interface AdminView {
  users: UserListRow[];
  events: EventRow[];
  q: string;
  resetLink?: { email: string; url: string } | null;
  errors?: Record<string, string>;
}

export function adminPage(ctx: Ctx, view: AdminView): SafeHtml {
  return page(ctx, {
    title: 'Administration',
    nav: 'admin',
    wide: true,
    body: html`
${pageHeader('Administration', { lead: 'Accounts and events on this instance.', actions: linkButton('/events/new', 'Create an event', 'primary') })}
${view.resetLink ? notice('success', html`Give this one-time link to ${view.resetLink.email}; it works once and expires in 2 days. There is no mail server, so Forgeboard does not send it.
  <span class="copy-row"><input class="copy-field" type="text" readonly value="${view.resetLink.url}" id="reset-link" aria-label="Password link"><button type="button" class="btn btn-secondary btn-sm" data-copy="reset-link">Copy</button></span>`, 'Link created.') : ''}
${formErrors(view.errors)}
<div class="two-col wide-left">
  ${section('People', html`
    <form method="get" action="/admin" class="filters compact" role="search">${input({ name: 'q', label: 'Find by name or email', type: 'search', value: view.q })}<div class="filter-actions">${button('Search', { variant: 'secondary' })}</div></form>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th scope="col">Person</th><th scope="col">Roles</th><th scope="col">Sign-in</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${view.users.map((u) => html`<tr>
        <td><strong>${u.name}</strong>${u.is_admin ? html` ${pill('admin', 'dark')}` : ''}<br><span class="muted">${u.email}</span> <code class="muted">${u.id}</code></td>
        <td class="small">${u.roles ?? html`<span class="muted">none</span>`}</td>
        <td>${u.password_hash ? pill('has password', 'success') : pill('no password', 'neutral')}</td>
        <td class="actions-cell">${actionForm(ctx, `/admin/users/${u.id}/link`, u.password_hash ? 'Reset link' : 'Setup link', { small: true })}
          ${u.id !== ctx.user?.id ? actionForm(ctx, `/admin/users/${u.id}/admin`, u.is_admin ? 'Remove admin' : 'Make admin', { small: true, variant: 'ghost', fields: { admin: u.is_admin ? '0' : '1' } }) : ''}</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="hint">Showing up to 200 people. Password links are the recovery path: an administrator creates one and hands it over.</p>`)}
  <aside>
    ${section('Events', html`<ul class="row-list">${view.events.map((e) => html`<li><span><a href="/events/${e.slug}">${e.name}</a> ${phasePill(phaseOf(e, ctx.now))}</span></li>`)}</ul>`)}
    ${section('Appoint an organizer', html`<form method="post" action="/admin/organizers" class="stack-form">${csrf(ctx)}
      <div class="field"><label for="event_id">Event</label><select id="event_id" name="event_id">${view.events.map((e) => html`<option value="${e.id}">${e.name}</option>`)}</select></div>
      ${input({ name: 'email', label: 'Email of an existing account', type: 'email', error: view.errors?.email })}
      ${button('Appoint', { variant: 'secondary' })}</form>
      <p class="hint">Administrators are not organizers of every event automatically; appoint yourself if you need access. The grant is audited on the event.</p>`)}
  </aside>
</div>`,
  });
}
