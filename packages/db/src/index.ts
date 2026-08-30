import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as sqliteSchema from './schema.sqlite';
import * as pgSchema from './schema.pg';

export * as sqliteSchema from './schema.sqlite';
export * as pgSchema from './schema.pg';

export type SqliteConn = {
  dialect: 'sqlite';
  db: BetterSQLite3Database<typeof sqliteSchema>;
  schema: typeof sqliteSchema;
};

export type PgConn = {
  dialect: 'postgresql';
  db: NodePgDatabase<typeof pgSchema>;
  schema: typeof pgSchema;
};

function resolveDialect(): 'sqlite' | 'postgresql' {
  const dialect = process.env.DB_DIALECT ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgresql') {
    throw new Error(`Unknown DB_DIALECT "${dialect}". Expected "sqlite" or "postgresql".`);
  }
  return dialect;
}

export function createDb(): SqliteConn | PgConn {
  const dialect = resolveDialect();

  if (dialect === 'sqlite') {
    const path = process.env.DB_PATH ?? './netpro.db';
    const sqlite = new Database(path);
    return { dialect, db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema };
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_DIALECT=postgresql');
  }
  const pool = new Pool({ connectionString });
  return { dialect, db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema };
}
