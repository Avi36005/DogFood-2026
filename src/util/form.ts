import { ValidationError } from './errors.ts';
import { fromDatetimeLocal } from './time.ts';

export type Body = Record<string, unknown>;

interface TextRule {
  label: string;
  required?: boolean;
  max?: number;
  min?: number;
}

/**
 * Reads a parsed form or JSON body field by field and collects every problem before
 * failing, so a person sees all of their mistakes at once instead of one per submit.
 */
export class FormReader {
  readonly errors: Record<string, string> = {};
  readonly #body: Body;

  constructor(body: Body) {
    this.#body = body;
  }

  raw(name: string): string {
    const value = this.#body[name];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
  }

  all(name: string): string[] {
    const value = this.#body[name];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string' && value !== '') return [value];
    return [];
  }

  fail(name: string, message: string): void {
    this.errors[name] ??= message;
  }

  text(name: string, rule: TextRule): string {
    const value = this.raw(name).replace(/\r\n/g, '\n').trim();
    const max = rule.max ?? 200;
    if (rule.required && value === '') this.fail(name, `${rule.label} is required.`);
    else if (value.length > max) this.fail(name, `${rule.label} must be ${max} characters or fewer.`);
    else if (rule.min && value.length > 0 && value.length < rule.min) {
      this.fail(name, `${rule.label} must be at least ${rule.min} characters.`);
    }
    return value;
  }

  email(name: string, label = 'Email'): string {
    const value = this.text(name, { label, required: true, max: 254 }).toLowerCase();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) this.fail(name, `${label} must be an email address.`);
    return value;
  }

  /** An optional http(s) URL. Anything else (javascript:, data:) is refused. */
  url(name: string, label: string): string {
    const value = this.text(name, { label, max: 500 });
    if (!value) return '';
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
      return parsed.toString();
    } catch {
      this.fail(name, `${label} must be a full http:// or https:// address.`);
      return value;
    }
  }

  int(name: string, rule: { label: string; min: number; max: number; fallback?: number }): number {
    const text = this.raw(name).trim();
    if (text === '' && rule.fallback !== undefined) return rule.fallback;
    const value = Number(text);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      this.fail(name, `${rule.label} must be a whole number from ${rule.min} to ${rule.max}.`);
      return rule.fallback ?? rule.min;
    }
    return value;
  }

  number(name: string, rule: { label: string; min: number; max: number }): number {
    const value = Number(this.raw(name).trim());
    if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
      this.fail(name, `${rule.label} must be a number from ${rule.min} to ${rule.max}.`);
      return rule.min;
    }
    return value;
  }

  /** A UTC instant from <input type="datetime-local">, or an ISO string sent over the API. */
  instant(name: string, rule: { label: string; required?: boolean }): string | null {
    const text = this.raw(name).trim();
    if (text === '') {
      if (rule.required) this.fail(name, `${rule.label} is required.`);
      return null;
    }
    const value = fromDatetimeLocal(text) ?? (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null);
    if (!value) this.fail(name, `${rule.label} must be a date and time.`);
    return value;
  }

  choice<T extends string>(name: string, options: readonly T[], label: string, required = true): T | null {
    const value = this.raw(name);
    if (value === '' && !required) return null;
    if (!options.includes(value as T)) {
      this.fail(name, `Choose a ${label.toLowerCase()}.`);
      return null;
    }
    return value as T;
  }

  checked(name: string): boolean {
    const value = this.raw(name);
    return value === 'on' || value === 'true' || value === '1';
  }

  get valid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  assertValid(): void {
    if (!this.valid) throw new ValidationError(this.errors);
  }
}

/** Lower-case, hyphenated, ASCII: "Sample Hack 2026" becomes "sample-hack-2026". */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
