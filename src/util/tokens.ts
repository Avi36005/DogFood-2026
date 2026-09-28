import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A short random id with a readable prefix, e.g. prj_k3v9x2m1qa7d. */
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

/** A bearer secret for a cookie or a one-time link: 256 bits, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as their SHA-256, so a copy of the database cannot be replayed as a login. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
