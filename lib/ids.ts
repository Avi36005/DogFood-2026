import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, sortable-enough, URL-safe id. Prefixed so ids are self-describing in logs. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(8);
  let tail = "";
  for (const b of rand) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${tail}`;
}

export function slugify(input: string, fallback = "item"): string {
  const s = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}
