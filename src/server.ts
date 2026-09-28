import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { boot, type Booted } from './boot.ts';
import { loadConfig, type Config } from './config.ts';
import { DEMO_PASSWORD } from './domain/demo.ts';
import { createApp } from './http/app.ts';
import { adminRoutes } from './routes/admin.ts';
import { apiRoutes } from './routes/api.ts';
import { authRoutes } from './routes/auth.ts';
import { judgeRoutes } from './routes/judge.ts';
import { organizeRoutes } from './routes/organize.ts';
import { publicRoutes } from './routes/public.ts';
import { teamRoutes } from './routes/teams.ts';

export interface Running {
  server: http.Server;
  booted: Booted;
  url: string;
  close(): Promise<void>;
}

export async function start(config: Config): Promise<Running> {
  const booted = await boot(config);
  const handler = createApp(booted.store, config, booted.secret, [publicRoutes, authRoutes, teamRoutes, judgeRoutes, organizeRoutes, adminRoutes, apiRoutes]);
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, handler);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://localhost:${port}`;
  if (!config.quiet) printBanner(booted, url);
  return {
    server,
    booted,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          booted.store.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function printBanner({ imported, demo, setupLink }: Booted, url: string): void {
  const lines = [`Forgeboard is listening on ${url}`];
  if (imported && !imported.skipped) {
    const c = imported.counts;
    lines.push(`imported ${imported.eventId} from fixtures.json: ${c.projects} projects, ${c.teams} teams, ${c.judges} judges, ${c.scores} scores`);
    for (const d of imported.duplicates) lines.push(`  duplicate submission: ${d.replaced.join(', ')} replaced by ${d.kept} (team ${d.team})`);
    for (const w of imported.warnings) lines.push(`  note: ${w}`);
  }
  if (demo.length) {
    lines.push('', 'seeded. test logins:');
    for (const account of demo) {
      if (account.token) lines.push(`  ${account.role.padEnd(12)} Cookie: session=${account.token}`);
    }
    lines.push('', `demo accounts (password "${DEMO_PASSWORD}"):`);
    for (const account of demo) lines.push(`  ${account.role.padEnd(12)} ${account.user.email}`);
    lines.push('', 'DEMO MODE: these sign-ins are public. Never enable FORGEBOARD_DEMO on an instance with real data.');
  }
  if (setupLink) lines.push('', 'No administrator has a password yet. Open this one-time link to set one:', `  ${setupLink}`);
  console.log(lines.join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const running = await start(loadConfig());
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
