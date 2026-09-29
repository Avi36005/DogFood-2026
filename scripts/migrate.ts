import { migrate, DB_PATH } from "../lib/db/client.ts";

migrate();
console.log(`[forgeboard] schema applied to ${DB_PATH}`);
