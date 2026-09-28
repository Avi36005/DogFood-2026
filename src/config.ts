import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  fixturesPath: string;
  /** Import fixturesPath at start (once; later starts see the event and skip it). */
  seedFixtures: boolean;
  publicUrl: string;
  /** Seeds the five demo accounts and the fixed checker sessions. Never set this in production. */
  demo: boolean;
  /** Email of the first administrator when not in demo mode. */
  adminEmail: string;
  cookieSecure: boolean;
  /** Behind a reverse proxy: take the client address from X-Forwarded-For. Only set this when a proxy is in front. */
  trustProxy: boolean;
  /** Overrides the signing secret that is otherwise generated once and kept in the database. */
  secret: string | null;
  quiet: boolean;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.FORGEBOARD_PORT ?? env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`FORGEBOARD_PORT must be a port number, got ${env.FORGEBOARD_PORT}`);
  }
  return {
    port,
    host: env.FORGEBOARD_HOST ?? '0.0.0.0',
    dbPath: path.resolve(env.FORGEBOARD_DB_PATH ?? './data/forgeboard.db'),
    fixturesPath: path.resolve(env.FORGEBOARD_FIXTURES ?? './fixtures.json'),
    seedFixtures: flag(env.FORGEBOARD_SEED_FIXTURES ?? env.FORGEBOARD_DEMO),
    publicUrl: (env.FORGEBOARD_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    demo: flag(env.FORGEBOARD_DEMO),
    adminEmail: env.FORGEBOARD_ADMIN_EMAIL ?? 'admin@localhost',
    cookieSecure: flag(env.FORGEBOARD_COOKIE_SECURE),
    trustProxy: flag(env.FORGEBOARD_TRUST_PROXY),
    secret: env.FORGEBOARD_SECRET ?? null,
    quiet: flag(env.FORGEBOARD_QUIET),
  };
}
