import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATIC_DIR = path.join(import.meta.dirname, '..', '..', 'static');

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  body: Buffer;
  type: string;
  hash: string;
}

/** Loaded once at start: a handful of small files, served from memory with a content hash for cache busting. */
export function loadStatic(): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  for (const name of fs.readdirSync(STATIC_DIR)) {
    const type = TYPES[path.extname(name)];
    if (!type) continue;
    const body = fs.readFileSync(path.join(STATIC_DIR, name));
    files.set(name, { body, type, hash: createHash('sha256').update(body).digest('hex').slice(0, 10) });
  }
  return files;
}
