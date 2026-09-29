/**
 * The instance's results-signing key: Ed25519 from node:crypto, created on first use and kept in
 * the settings table (so a backup carries it). Public keys travel as the raw 32 bytes in
 * base64url, the form WebCrypto imports directly, so a browser can check a signature with no
 * library and no server.
 *
 * What a signature proves: this instance published exactly this document. What it does not
 * prove: that the instance's operator was honest. Anyone who controls the database controls the
 * key; the defence against a later rewrite is that the signed document has already left the
 * building (downloaded, mailed, archived) and quotes the audit chain's head at that moment.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Store } from '../db/store.ts';

const PRIVATE_SETTING = 'results_signing_key';

export interface SigningKey {
  privateKey: KeyObject;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
}

export function signingKey(store: Store): SigningKey {
  const stored = store.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [PRIVATE_SETTING]);
  let privateKey: KeyObject;
  if (stored) {
    privateKey = createPrivateKey(stored.value);
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    store.run('INSERT INTO settings (key, value) VALUES (?, ?)', [PRIVATE_SETTING, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string]);
  }
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return { privateKey, publicKey: jwk.x as string };
}

export function signText(key: SigningKey, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64url');
}

export function verifyText(text: string, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
