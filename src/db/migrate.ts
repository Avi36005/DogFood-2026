import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/** Applies every migration in migrations/ that has not run yet, in filename order, each in its own transaction. */
export function migrate(store: Store): string[] {
  store.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    store.all<{ version: string }>('SELECT version FROM schema_migrations').map((row) => row.version),
  );
  const pending = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => !applied.has(file));

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    store.tx(() => {
      store.exec(sql);
      store.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
    });
  }
  return pending;
}
