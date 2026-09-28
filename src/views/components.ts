import type { Ctx } from '../http/context.ts';
import { formatUtc, relative } from '../util/time.ts';
import { cx, html, type Renderable, type SafeHtml } from './html.ts';

export function csrf(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrfToken}">`;
}

interface FieldBase {
  name: string;
  /** Element id; defaults to the name. Set it when two forms on one page share a field name. */
  id?: string;
  label: string;
  hint?: Renderable;
  error?: string;
  required?: boolean;
}

interface InputField extends FieldBase {
  type?: 'text' | 'email' | 'password' | 'url' | 'number' | 'datetime-local' | 'search';
  value?: string | number | null;
  placeholder?: string;
  autocomplete?: string;
  min?: number;
  max?: number;
  step?: string;
  maxlength?: number;
}

const idOf = (field: FieldBase) => field.id ?? field.name;

function describedBy(field: FieldBase): string | null {
  const ids = [field.hint ? `${idOf(field)}-hint` : null, field.error ? `${idOf(field)}-error` : null].filter(Boolean);
  return ids.length ? ids.join(' ') : null;
}

function wrap(field: FieldBase, control: SafeHtml): SafeHtml {
  return html`<div class="${cx('field', field.error && 'has-error')}">
    <label for="${idOf(field)}">${field.label}${field.required ? html`<span class="req" aria-hidden="true"> *</span>` : ''}</label>
    ${control}
    ${field.hint ? html`<p class="hint" id="${idOf(field)}-hint">${field.hint}</p>` : ''}
    ${field.error ? html`<p class="error-text" id="${idOf(field)}-error">${field.error}</p>` : ''}
  </div>`;
}

const attr = (name: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '' : html` ${name}="${value}"`;

export function input(field: InputField): SafeHtml {
  const by = describedBy(field);
  return wrap(field, html`<input id="${idOf(field)}" name="${field.name}" type="${field.type ?? 'text'}"${attr('value', field.value)}${attr('placeholder', field.placeholder)}${attr('autocomplete', field.autocomplete)}${attr('min', field.min)}${attr('max', field.max)}${attr('step', field.step)}${attr('maxlength', field.maxlength)}${attr('aria-describedby', by)}${field.required ? html` required` : ''}${field.error ? html` aria-invalid="true"` : ''}>`);
}

export function textarea(field: FieldBase & { value?: string; rows?: number; maxlength?: number }): SafeHtml {
  const by = describedBy(field);
  return wrap(field, html`<textarea id="${idOf(field)}" name="${field.name}" rows="${field.rows ?? 5}"${attr('maxlength', field.maxlength)}${attr('aria-describedby', by)}${field.required ? html` required` : ''}${field.error ? html` aria-invalid="true"` : ''}>${field.value ?? ''}</textarea>`);
}

export function select(field: FieldBase & { value?: string | null; options: { value: string; label: string }[]; blank?: string }): SafeHtml {
  const by = describedBy(field);
  return wrap(field, html`<select id="${idOf(field)}" name="${field.name}"${attr('aria-describedby', by)}${field.required ? html` required` : ''}${field.error ? html` aria-invalid="true"` : ''}>
    ${field.blank !== undefined ? html`<option value="">${field.blank}</option>` : ''}
    ${field.options.map((o) => html`<option value="${o.value}"${o.value === field.value ? html` selected` : ''}>${o.label}</option>`)}
  </select>`);
}

export function checkboxes(field: FieldBase & { values: string[]; options: { value: string; label: string }[] }): SafeHtml {
  return html`<fieldset class="${cx('field', 'checks', field.error && 'has-error')}">
    <legend>${field.label}</legend>
    ${field.hint ? html`<p class="hint">${field.hint}</p>` : ''}
    <div class="check-grid">
      ${field.options.map((o, i) => html`<label class="check"><input type="checkbox" name="${field.name}" value="${o.value}" id="${idOf(field)}-${i}"${field.values.includes(o.value) ? html` checked` : ''}> <span>${o.label}</span></label>`)}
    </div>
    ${field.error ? html`<p class="error-text">${field.error}</p>` : ''}
  </fieldset>`;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function button(label: Renderable, options: { variant?: Variant; name?: string; value?: string; type?: 'submit' | 'button'; small?: boolean } = {}): SafeHtml {
  return html`<button type="${options.type ?? 'submit'}" class="${cx('btn', `btn-${options.variant ?? 'primary'}`, options.small && 'btn-sm')}"${attr('name', options.name)}${attr('value', options.value)}>${label}</button>`;
}

export function linkButton(href: string, label: Renderable, variant: Variant = 'secondary', small = false): SafeHtml {
  return html`<a class="${cx('btn', `btn-${variant}`, small && 'btn-sm')}" href="${href}">${label}</a>`;
}

/** A one-button form for an action (sign out, auto-assign). */
export function actionForm(ctx: Ctx, action: string, label: string, options: { variant?: Variant; small?: boolean; fields?: Record<string, string> } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form">${csrf(ctx)}${Object.entries(options.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${button(label, { variant: options.variant ?? 'secondary', small: options.small })}</form>`;
}

/**
 * An action that needs a second, deliberate click (publish, close submissions). Uses a
 * disclosure rather than a browser confirm() so it works without JavaScript and reads well
 * to a screen reader.
 */
export function confirmForm(ctx: Ctx, action: string, label: string, explanation: Renderable, confirmLabel: string, variant: Variant = 'primary'): SafeHtml {
  return html`<details class="confirm">
    <summary class="${cx('btn', `btn-${variant}`)}">${label}</summary>
    <div class="confirm-panel">
      <p>${explanation}</p>
      <form method="post" action="${action}">${csrf(ctx)}${button(confirmLabel, { variant })}</form>
    </div>
  </details>`;
}

export function pill(text: Renderable, tone: 'neutral' | 'success' | 'warn' | 'danger' | 'info' | 'dark' = 'neutral'): SafeHtml {
  return html`<span class="${cx('pill', `pill-${tone}`)}">${text}</span>`;
}

export function when(iso: string | null, now: Date, options: { relative?: boolean } = {}): SafeHtml {
  if (!iso) return html`<span class="muted">not set</span>`;
  return html`<time datetime="${iso}">${formatUtc(iso)}</time>${options.relative === false ? '' : html` <span class="muted">(${relative(iso, now)})</span>`}`;
}

export function notice(kind: 'success' | 'error' | 'info' | 'warn', body: Renderable, title?: string): SafeHtml {
  const role = kind === 'error' ? 'alert' : 'status';
  return html`<div class="${cx('notice', `notice-${kind}`)}" role="${role}">${title ? html`<strong>${title}</strong> ` : ''}${body}</div>`;
}

export function empty(title: string, body: Renderable, action?: SafeHtml): SafeHtml {
  return html`<div class="empty"><p class="empty-title">${title}</p><p>${body}</p>${action ?? ''}</div>`;
}

export function stat(label: string, value: Renderable, hint?: Renderable): SafeHtml {
  return html`<div class="stat"><p class="stat-label">${label}</p><p class="stat-value">${value}</p>${hint ? html`<p class="stat-hint">${hint}</p>` : ''}</div>`;
}

/** A native <progress>: accessible by default and needs no inline style, which the CSP forbids. */
export function meter(value: number, max: number, label: string): SafeHtml {
  return html`<progress class="meter" value="${value}" max="${Math.max(max, 1)}" aria-label="${label}">${value} of ${max}</progress>`;
}

export function pageHeader(title: Renderable, options: { eyebrow?: Renderable; lead?: Renderable; actions?: Renderable } = {}): SafeHtml {
  return html`<div class="page-header">
    <div>
      ${options.eyebrow ? html`<p class="eyebrow">${options.eyebrow}</p>` : ''}
      <h1>${title}</h1>
      ${options.lead ? html`<p class="lead">${options.lead}</p>` : ''}
    </div>
    ${options.actions ? html`<div class="page-actions">${options.actions}</div>` : ''}
  </div>`;
}

export function section(title: Renderable, body: Renderable, options: { actions?: Renderable; id?: string; lead?: Renderable } = {}): SafeHtml {
  return html`<section class="panel"${attr('id', options.id)}>
    <div class="panel-head"><div><h2>${title}</h2>${options.lead ? html`<p class="muted">${options.lead}</p>` : ''}</div>${options.actions ? html`<div class="panel-actions">${options.actions}</div>` : ''}</div>
    ${body}
  </section>`;
}

/** Numbers in tables use tabular figures; this keeps the decimals honest and aligned. */
export function num(value: number | null | undefined, places = 2): SafeHtml {
  if (value === null || value === undefined || !Number.isFinite(value)) return html`<span class="muted">–</span>`;
  return html`<span class="num">${value.toFixed(places)}</span>`;
}

export function signed(value: number, places = 2): SafeHtml {
  const text = `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(places)}`;
  return html`<span class="${cx('num', value > 0 && 'pos', value < 0 && 'neg')}">${text}</span>`;
}

export function formErrors(errors: Record<string, string> | undefined): SafeHtml {
  if (!errors || Object.keys(errors).length === 0) return html``;
  return notice('error', html`<ul>${Object.values(errors).map((e) => html`<li>${e}</li>`)}</ul>`, 'Please fix the following:');
}
