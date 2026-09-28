import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/**
 * A thin wrapper over node:sqlite: cached prepared statements, typed row helpers and
 * transactions. There is deliberately no query builder; the SQL is the documentation.
 */
export class Store {
  readonly db: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const statement = this.#prepare(sql);
    return (Array.isArray(params) ? statement.all(...params) : statement.all(params)) as T[];
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const statement = this.#prepare(sql);
    return (Array.isArray(params) ? statement.get(...params) : statement.get(params)) as T | undefined;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const statement = this.#prepare(sql);
    const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Runs fn inside one transaction. BEGIN IMMEDIATE takes the write lock up front, so a
   * check-then-write (the deadline, a team's size) cannot interleave with another writer.
   * Nested calls join the outer transaction through a savepoint.
   */
  tx<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const savepoint = `sp_${this.#depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Store.tx callbacks must be synchronous');
      this.#depth--;
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.#depth--;
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
