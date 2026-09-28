/** All instants are stored and compared as UTC. Display is UTC too, labelled, so nobody guesses a timezone. */

export function iso(date: Date): string {
  return date.toISOString();
}

/** Parses an ISO timestamp from the database or an import, rejecting anything that is not a real instant. */
export function parseInstant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`not a timestamp: ${value}`);
  return date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "1 Mar 2026, 18:00 UTC" */
export function formatUtc(value: string | Date): string {
  const d = typeof value === 'string' ? parseInstant(value) : value;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "1 Mar 2026" */
export function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? parseInstant(value) : value;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "in 3 days", "2 hours ago": coarse on purpose, the exact instant is always shown beside it. */
export function relative(value: string | Date, now: Date): string {
  const d = typeof value === 'string' ? parseInstant(value) : value;
  const seconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const units: [number, string][] = [
    [86400 * 365, 'year'],
    [86400 * 30, 'month'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return seconds > 0 ? `in ${label}` : `${label} ago`;
    }
  }
  return seconds > 0 ? 'in under a minute' : 'just now';
}

/** Value for <input type="datetime-local">, in UTC. */
export function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  return parseInstant(value).toISOString().slice(0, 16);
}

/** Reads a datetime-local value as UTC. Returns null for an empty or malformed value. */
export function fromDatetimeLocal(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(`${value.length === 16 ? `${value}:00` : value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400_000);
}
