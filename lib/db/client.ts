import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DB_PATH =
  process.env.FORGEBOARD_DB_PATH ?? path.join(process.cwd(), "data", "forgeboard.db");

export const UPLOAD_DIR =
  process.env.FORGEBOARD_UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads");

type Global = typeof globalThis & { __forgeboardDb?: DatabaseSync };
const g = globalThis as Global;

export function db(): DatabaseSync {
  if (!g.__forgeboardDb) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const conn = new DatabaseSync(DB_PATH);
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA foreign_keys = ON;");
    conn.exec("PRAGMA busy_timeout = 5000;");
    g.__forgeboardDb = conn;
  }
  return g.__forgeboardDb;
}

/**
 * Columns added to tables that already existed in an earlier release. New
 * tables and indexes need nothing here because schema.sql creates them with
 * IF NOT EXISTS; a column does not work that way, so each one is added only
 * when the database on disk is missing it. Additive only: nothing here drops
 * or rewrites a column, so an older file opens without losing anything.
 */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["projects", "disqualified_at", "TEXT"],
  ["custom_questions", "is_public", "INTEGER NOT NULL DEFAULT 0"],
];

/** Applies schema.sql, then any column an older database is missing. Idempotent. */
export function migrate(conn: DatabaseSync = db()): void {
  const sql = readFileSync(path.join(process.cwd(), "lib", "db", "schema.sql"), "utf8");
  conn.exec(sql);
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0 || columns.some((c) => c.name === column)) continue;
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[forgeboard] added column ${table}.${column}`);
  }
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...(params as never[]));
}

/** Wraps fn in an IMMEDIATE transaction so concurrent writers fail fast rather than interleave. */
export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    try { conn.exec("ROLLBACK"); } catch { /* connection already rolled back */ }
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
