/**
 * Operator commands, run next to the server:
 *   docker compose exec forgeboard node src/cli.ts <command> [argument]
 */
import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { Store } from './db/store.ts';
import { createPasswordLink, findUserByEmail } from './domain/accounts.ts';
import { record } from './domain/audit.ts';
import { importFixtures } from './domain/fixtures.ts';
import { systemActor } from './domain/types.ts';

const USAGE = `Usage: node src/cli.ts <command> [argument]

  backup <file>           Write a consistent copy of the database to <file>. Safe while the server runs.
  import <fixtures.json>  Import an event in the DOGFOOD fixtures format. Validated first; all or nothing.
  password-link <email>   Print a one-time link to set a password (account recovery; there is no mail server).
  make-admin <email>      Give an existing account administrator access.
`;

function main(argv: string[]): number {
  const [command, argument] = argv;
  if (!command || !argument) {
    process.stdout.write(USAGE);
    return command ? 1 : 0;
  }
  const config = loadConfig();
  const store = new Store(config.dbPath);
  migrate(store);
  const actor = systemActor();
  try {
    switch (command) {
      case 'backup': {
        if (fs.existsSync(argument)) throw new Error(`${argument} already exists; choose a new file name`);
        store.run('VACUUM INTO ?', [argument]);
        console.log(`backed up ${config.dbPath} to ${argument}`);
        return 0;
      }
      case 'import': {
        const report = importFixtures(store, actor, JSON.parse(fs.readFileSync(argument, 'utf8')));
        if (report.skipped) console.log(`event ${report.eventId} already exists; nothing imported`);
        else console.log(`imported ${report.eventId}: ${Object.entries(report.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        for (const warning of report.warnings) console.log(`  note: ${warning}`);
        return 0;
      }
      case 'password-link': {
        const user = findUserByEmail(store, argument);
        if (!user) throw new Error(`no account uses ${argument}`);
        const token = store.tx(() => createPasswordLink(store, actor, user, user.password_hash ? 'reset' : 'setup', 2));
        console.log(`one-time link for ${user.email}, valid for 2 days:\n  ${config.publicUrl}/password/${token}`);
        return 0;
      }
      case 'make-admin': {
        const user = findUserByEmail(store, argument);
        if (!user) throw new Error(`no account uses ${argument}`);
        store.tx(() => {
          store.run('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id]);
          record(store, actor, { action: 'admin.granted', subjectType: 'user', subjectId: user.id, summary: `Made ${user.email} an administrator from the command line.` });
        });
        console.log(`${user.email} is now an administrator`);
        return 0;
      }
      default:
        process.stdout.write(USAGE);
        return 1;
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }
}

process.exitCode = main(process.argv.slice(2));
