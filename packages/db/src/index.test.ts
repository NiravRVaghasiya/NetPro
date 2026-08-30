import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.sqlite';

describe('packages/db schema', () => {
  it('exports all fourteen tables including Auth.js adapter tables', () => {
    const tableNames = [
      'contacts', 'interactions', 'edges', 'enrichments', 'campaigns',
      'campaignRecipients', 'searchIndex', 'profileViews', 'followUps', 'activityLog',
      'users', 'accounts', 'sessions', 'verificationTokens',
    ];
    for (const name of tableNames) {
      expect(schema).toHaveProperty(name);
    }
  });

  it('wires an in-memory SQLite database without throwing', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    expect(db).toBeDefined();
  });
});
