import { rmSync } from "node:fs";
import { DB_PATH } from "../lib/db/client.ts";

for (const suffix of ["", "-wal", "-shm"]) {
  try { rmSync(DB_PATH + suffix); } catch { /* absent is fine */ }
}
console.log(`[forgeboard] removed ${DB_PATH}`);
