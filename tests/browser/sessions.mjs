/**
 * Mints real sessions for the demo accounts, so the HTTP and browser checks can
 * act as each role without typing a password thirty times. It writes exactly
 * the row `issueSession()` writes: a random token, only its SHA-256 stored.
 *
 * The database is found in this order:
 *   FORGEBOARD_DB_PATH → the running compose container → ./data/forgeboard.db
 *
 * The container comes before the local file on purpose: when both exist, the
 * server under test is almost always the container, and minting a session in
 * the wrong database produces a confusing wall of 401s.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** The compose container, when it is running. */
export function containerName() {
  const name = process.env.FORGEBOARD_CONTAINER ?? "forgeboard";
  try {
    const state = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return state === "true" ? name : null;
  } catch { return null; }
}

/** Runs a Node module string against whichever database is in play. */
export function runAgainstDb(code) {
  if (process.env.FORGEBOARD_DB_PATH) {
    return execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env }).toString();
  }
  const container = containerName();
  if (container) {
    return execFileSync("docker", ["exec", "-i", container, "node", "--input-type=module", "-e", code]).toString();
  }
  const local = path.join(process.cwd(), "data", "forgeboard.db");
  if (!existsSync(local)) throw new Error("no database: start the container, or run npm run db:seed");
  return execFileSync(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, FORGEBOARD_DB_PATH: local } }).toString();
}

const ROLES = ["organizer", "judge", "participant", "admin"];

const MINT = `
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
const db = new DatabaseSync(process.env.FORGEBOARD_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000;");
const out = {};
const mint = (userId) => {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)")
    .run("ses_" + randomBytes(10).toString("hex"), userId, createHash("sha256").update(token).digest("hex"),
         new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return token;
};
for (const role of ${JSON.stringify(ROLES)}) {
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(role + "@forgeboard.local");
  if (u) out[role] = mint(u.id);
}
// A judge who still has unfinished work, for the keyboard checks.
const busy = db.prepare(\`SELECT u.id FROM assignments a JOIN users u ON u.id = a.judge_user_id
  LEFT JOIN reviews r ON r.assignment_id = a.id
  WHERE r.id IS NULL OR r.status != 'submitted' LIMIT 1\`).get();
if (busy) out.busyjudge = mint(busy.id);
console.log(JSON.stringify(out));
`;

export function mintSessions() {
  return JSON.parse(runAgainstDb(MINT).trim().split("\n").pop());
}
