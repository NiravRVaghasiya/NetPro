// Test-only entry point: do not export from the runtime package barrel.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.sqlite";
import type { SqliteConn } from "./index";

/** Exercise committed migrations instead of duplicating CREATE TABLE in new tests. */
export function createTestSqliteConn(): {
  conn: SqliteConn;
  sqlite: Database.Database;
} {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../migrations/sqlite", import.meta.url),
    ),
  });
  return { conn: { dialect: "sqlite", db, schema }, sqlite };
}
