import { defineConfig } from 'drizzle-kit';

const dialect = (process.env.DB_DIALECT ?? 'sqlite') as 'sqlite' | 'postgresql';

export default dialect === 'sqlite'
  ? defineConfig({
      schema: './src/schema.sqlite.ts',
      out: './migrations/sqlite',
      dialect: 'sqlite',
      dbCredentials: { url: process.env.DB_PATH ?? './netpro.db' },
    })
  : defineConfig({
      schema: './src/schema.pg.ts',
      out: './migrations/postgres',
      dialect: 'postgresql',
      dbCredentials: { url: process.env.DATABASE_URL! },
    });
