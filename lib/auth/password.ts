import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// scrypt from the Node standard library: no native build step, no external
// service, and memory-hard. Cost chosen so a single verify stays well under
// 100ms on a laptop while remaining expensive to attack in bulk.
const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifyPassword(plain: string, hash: string, salt: string): boolean {
  try {
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(plain, Buffer.from(salt, "hex"), expected.length, { N, r, p });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function passwordProblem(plain: string): string | null {
  if (plain.length < 10) return "Use at least 10 characters.";
  if (plain.length > 200) return "Use at most 200 characters.";
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain))
    return "Include at least one letter and one number.";
  return null;
}
