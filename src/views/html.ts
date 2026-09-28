/**
 * Server-side HTML templating with escaping by default.
 *
 * Every interpolated value is escaped unless it is already SafeHtml, which only this module
 * and `raw()` can produce. There is no way to render user text unescaped by accident.
 */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export type Renderable = SafeHtml | string | number | boolean | null | undefined | Renderable[];

function render(value: Renderable): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** Marks trusted markup (never user input) as safe. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Joins class names, skipping falsy ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
