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

