/**
 * Operator commands, run next to the server:
 *   docker compose exec forgeboard node src/cli.ts <command> [argument]
 */
import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { Store } from './db/store.ts';
import { createPasswordLink, findUserByEmail } from './domain/accounts.ts';
import { record, verifyChain } from './domain/audit.ts';
import { parseBundle, verifyBundle } from './domain/evidence.ts';
import { importFixtures } from './domain/fixtures.ts';
import { verifyText } from './domain/signing.ts';
import { systemActor } from './domain/types.ts';

const USAGE = `Usage: node src/cli.ts <command> [argument]

  backup <file>           Write a consistent copy of the database to <file>. Safe while the server runs.
  import <fixtures.json>  Import an event in the DOGFOOD fixtures format. Validated first; all or nothing.
  password-link <email>   Print a one-time link to set a password (account recovery; there is no mail server).
  make-admin <email>      Give an existing account administrator access.
  verify-audit            Recompute every hash in the audit chain and report the first entry that does not verify.
  verify-record <file>    Check a signed certificate or judge record (the JSON the portal served) offline.
  verify-results <file>   Check a signed results file offline: results.json from the public results page, or a
                          results capsule (.html). Verifies the Ed25519 signature and, when the file carries the
                          inputs, their fingerprint and a refit of the ranking. Needs no database.
`;

function verifyResultsFile(file: string): number {
  const report = verifyBundle(parseBundle(fs.readFileSync(file, 'utf8')));
  const line = (label: string, ok: boolean | null, detail: string) => console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${detail}`);
  line('signature', report.signature, report.signature ? 'Ed25519 signature matches the document' : 'does not match');
  line('inputs fingerprint', report.fingerprint, report.fingerprint === null ? 'no inputs in this file (the capsule has them)' : report.fingerprint ? 'inputs are the ones the document describes' : 'inputs differ');
  line('refit', report.refit, report.refit === null ? 'no inputs to refit' : report.refit ? 'refitting reproduces every published score and rank' : 'refit differs');
  for (const problem of report.problems) console.log(`      ${problem}`);
  return report.problems.length ? 1 : 0;
}

function main(argv: string[]): number {
  const [command, argument] = argv;
  if (command === 'verify-record' && argument) {
    try {
      const record = JSON.parse(fs.readFileSync(argument, 'utf8')) as { document_text?: string; signature?: string; public_key?: string; format?: string };
      const ok = Boolean(record.document_text && record.signature && record.public_key && verifyText(record.document_text, record.signature, record.public_key));
      const document = record.document_text ? (JSON.parse(record.document_text) as { format?: string; results?: { all_counted?: boolean; not_counted?: { project: string; reason: string }[] } | null }) : {};
      console.log(`${ok ? 'PASS' : 'FAIL'}  signature            ${ok ? 'Ed25519 signature matches the record' : 'does not match: changed after signing, or another key'}`);
      console.log(`      format               ${document.format ?? 'unknown'}`);
      console.log(`      public key           ${record.public_key ?? 'missing'} (compare with the portal's results.json)`);
      if (document.results && 'all_counted' in document.results) {
        console.log(`${document.results.all_counted ? 'PASS' : 'FAIL'}  counted              ${document.results.all_counted ? 'every review of a ranked project is in the signed inputs at its value' : 'a review is missing from the signed inputs'}`);
        for (const n of document.results.not_counted ?? []) console.log(`      not counted          ${n.project}: ${n.reason}`);
      }
      return ok && document.results?.all_counted !== false ? 0 : 1;
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === 'verify-results' && argument) {
    try {
      return verifyResultsFile(argument);
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (!command || (!argument && command !== 'verify-audit')) {
    process.stdout.write(USAGE);
    return command ? 1 : 0;
  }
  // Every command below except verify-audit was checked above to have its argument.
  const target = argument ?? '';
  const config = loadConfig();
  const store = new Store(config.dbPath);
  migrate(store);
  const actor = systemActor();
  try {
    switch (command) {
      case 'verify-audit': {
        const chain = verifyChain(store);
        if (chain.ok) {
          console.log(`PASS  ${chain.verified} chained entries verify${chain.unchained ? ` (${chain.unchained} older entries predate the chain)` : ''}`);
          if (chain.head) console.log(`      head #${chain.head.id} ${chain.head.hash}`);
          return 0;
        }
        console.log(`FAIL  entry #${chain.broken?.id}: ${chain.broken?.reason}`);
        return 1;
      }
      case 'backup': {
        if (fs.existsSync(target)) throw new Error(`${target} already exists; choose a new file name`);
        store.run('VACUUM INTO ?', [target]);
        console.log(`backed up ${config.dbPath} to ${target}`);
        return 0;
      }
      case 'import': {
        const report = importFixtures(store, actor, JSON.parse(fs.readFileSync(target, 'utf8')));
        if (report.skipped) console.log(`event ${report.eventId} already exists; nothing imported`);
        else console.log(`imported ${report.eventId}: ${Object.entries(report.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        for (const warning of report.warnings) console.log(`  note: ${warning}`);
        return 0;
      }
      case 'password-link': {
        const user = findUserByEmail(store, target);
        if (!user) throw new Error(`no account uses ${target}`);
        const token = store.tx(() => createPasswordLink(store, actor, user, user.password_hash ? 'reset' : 'setup', 2));
        console.log(`one-time link for ${user.email}, valid for 2 days:\n  ${config.publicUrl}/password/${token}`);
        return 0;
      }
      case 'make-admin': {
        const user = findUserByEmail(store, target);
        if (!user) throw new Error(`no account uses ${target}`);
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
