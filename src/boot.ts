import fs from 'node:fs';
import type { Config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { Store } from './db/store.ts';
import { createPasswordLink, ensureUser } from './domain/accounts.ts';
import { seedDemo, type DemoAccount } from './domain/demo.ts';
import { importFixtures, type ImportReport } from './domain/fixtures.ts';
import { pruneExpiredSessions } from './domain/sessions.ts';
import { systemActor, type UserRow } from './domain/types.ts';
import { newToken } from './util/tokens.ts';

export interface Booted {
  store: Store;
  secret: string;
  imported: ImportReport | null;
  demo: DemoAccount[];
  setupLink: string | null;
}

function secretFor(store: Store, config: Config): string {
  if (config.secret) return config.secret;
  const existing = store.get<{ value: string }>("SELECT value FROM settings WHERE key = 'secret'");
  if (existing) return existing.value;
  const secret = newToken();
  store.run("INSERT INTO settings (key, value) VALUES ('secret', ?)", [secret]);
  return secret;
}

/**
 * Brings a database from nothing to ready, safely on every start: migrate, import the fixtures
 * once, then either seed the demo accounts or make sure a first administrator can get in.
 */
export async function boot(config: Config, now = new Date()): Promise<Booted> {
  const store = new Store(config.dbPath);
  migrate(store);
  const secret = secretFor(store, config);
  const actor = systemActor(now);
  pruneExpiredSessions(store, now);

  let imported: ImportReport | null = null;
  if (config.seedFixtures && fs.existsSync(config.fixturesPath)) {
    imported = importFixtures(store, actor, JSON.parse(fs.readFileSync(config.fixturesPath, 'utf8')));
  }

  let demo: DemoAccount[] = [];
  let setupLink: string | null = null;
  if (config.demo) {
    const eventId = imported?.eventId ?? store.get<{ id: string }>("SELECT id FROM events WHERE source = 'fixture' ORDER BY created_at LIMIT 1")?.id;
    if (eventId) demo = await seedDemo(store, actor, eventId);
  } else {
    // First run without demo mode: create the administrator account without a password and
    // print a one-time link to set it. Printed again on each start until it has been used.
    const admins = store.all<UserRow>('SELECT * FROM users WHERE is_admin = 1');
    if (!admins.some((u) => u.password_hash)) {
      const admin = admins[0] ?? ensureUser(store, config.adminEmail, 'Administrator', now);
      store.run('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
      setupLink = `${config.publicUrl}/password/${createPasswordLink(store, actor, admin, 'setup', 1)}`;
    }
  }
  return { store, secret, imported, demo, setupLink };
}
