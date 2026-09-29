/**
 * Operator recovery, for when nobody can sign in at all:
 *
 *     npm run user:reset -- someone@example.org
 *     docker compose exec forgeboard node scripts/reset-password.ts someone@example.org
 *
 * Prints a one-use link, valid for an hour. Whoever runs this already has the
 * database in their hands, so the link grants nothing they could not take
 * anyway; it is the safe, audited way to hand access back to a person.
 */
import * as accounts from "../lib/domain/accounts.ts";

const email = process.argv[2];
const base = process.env.FORGEBOARD_BASE_URL ?? "http://localhost:3000";

if (!email) {
  console.error("Usage: node scripts/reset-password.ts <email>");
  process.exit(2);
}

const user = accounts.byEmail(email);
if (!user) {
  console.error(`No account on this instance for ${email}.`);
  process.exit(1);
}
if (user.disabled_at) {
  console.error(`${user.email} is disabled. Enable the account first.`);
  process.exit(1);
}

const { token, expiresAt } = accounts.issuePasswordReset(user, null);
console.log(`\nRecovery link for ${user.display_name} <${user.email}>:\n`);
console.log(`  ${base}/reset/${token}\n`);
console.log(`Valid until ${expiresAt.replace("T", " ").slice(0, 19)} UTC. It works once,`);
console.log("and using it signs that account out of every existing session.\n");
