// Phase 22 — the PostgreSQL half of the migration-preservation matrix.
//
// Same journey as migration-preservation.test.ts, against a real server:
// a v2.5-era database (0000–0007) with representative rows upgrades to the
// current schema with every row preserved and backfilled, the tsvector
// column generated and GIN-indexed, and a failing migration recoverable.
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// the default `npm test` stays hermetic. CI runs this in postgres-integration
// (the whole @netpro/db suite). Locally:
//
//   docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=netpro postgres:16-alpine
//   NETPRO_TEST_DATABASE_URL=postgresql://postgres:netpro@127.0.0.1:5433/postgres \
//     npm run test -w @netpro/db -- src/postgres.preservation.test.ts

import { afterAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.pg';
import type { PgConn } from './index';
import {
  appliedMigrationCount,
  pendingMigrationTotal,
  resolveMigrationsFolder,
  runMigrations,
} from './migrate';

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const folder = fileURLToPath(new URL('../migrations/postgres', import.meta.url));

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as Journal;
}

function fixtureFolder(maxIdx: number): string {
  const journal = readJournal();
  const subset = journal.entries.filter((e) => e.idx < maxIdx);
  const expected = Array.from({ length: maxIdx }, (_, i) => i);
  expect(subset.map((e) => e.idx)).toEqual(expected);
  const dir = mkdtempSync(join(tmpdir(), 'netpro-pg-preserve-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: subset }));
  for (const entry of subset) {
    copyFileSync(join(folder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const created: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `netpro_test_preserve_${label}_${Date.now().toString(36)}`;
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
  created.push(name);
  return name;
}

function connect(name: string): PgConn {
  const pool = new Pool({ connectionString: databaseUrl(name) });
  return { dialect: 'postgresql', db: drizzle(pool, { schema }), schema, pool };
}

const T = '2026-01-01T00:00:00.000Z';

/** One representative row per v2.5-era data table (raw SQL: the schema is the NEW one). */
async function seedV25(conn: PgConn): Promise<void> {
  const db = conn.db;
  await db.execute(sql`INSERT INTO contacts (id, full_name, email, company, role, source, relationship_score, skills, created_at, updated_at)
    VALUES ('ada', 'Ada Lovelace', 'ada@example.com', 'Analytical Engines', 'Mathematician', 'linkedin', 0.9, '["python","math"]', ${T}, ${T})`);
  await db.execute(sql`INSERT INTO contacts (id, full_name, source, created_at, updated_at)
    VALUES ('grace', 'Grace Hopper', 'linkedin', ${T}, ${T})`);
  await db.execute(sql`INSERT INTO interactions (id, contact_id, type, subject, content, sentiment, occurred_at, created_at)
    VALUES ('i1', 'ada', 'meeting', 'Intro call', 'Talked compilers.', 'positive', ${T}, ${T})`);
  await db.execute(sql`INSERT INTO edges (id, source_id, target_id, relation, strength, source, confidence, status, discovered_at, updated_at)
    VALUES ('e1', 'ada', 'grace', 'colleague', 0.8, 'csv', 0.9, 'pending', ${T}, ${T})`);
  await db.execute(sql`INSERT INTO events (id, name, location, starts_at, source, created_at)
    VALUES ('ev1', 'Engines Conf', 'London', ${T}, 'csv', ${T})`);
  await db.execute(sql`INSERT INTO event_attendees (event_id, contact_id, role, discovered_at)
    VALUES ('ev1', 'ada', 'speaker', ${T})`);
  await db.execute(sql`INSERT INTO enrichments (id, contact_id, provider, data_type, raw_payload, confidence, fetched_at)
    VALUES ('en1', 'ada', 'hunter', 'email', '{"email":"ada@example.com"}', 0.95, ${T})`);
  await db.execute(sql`INSERT INTO campaigns (id, name, status, type, daily_limit, created_at, updated_at)
    VALUES ('camp1', 'Q1 intros', 'active', 'drip', 10, ${T}, ${T})`);
  await db.execute(sql`INSERT INTO campaign_recipients (id, campaign_id, contact_id, status, current_step)
    VALUES ('cr1', 'camp1', 'grace', 'sent', 2)`);
  await db.execute(sql`INSERT INTO search_index (contact_id, search_text, content_hash, updated_at)
    VALUES ('ada', 'ada lovelace analytical engines mathematician', 'hash-ada', ${T})`);
  await db.execute(sql`INSERT INTO profile_views (id, viewer_ip, is_bot, is_owner_view, duration_ms, viewed_page, viewed_at)
    VALUES ('v1', 'a1b2c3d4e5f60718', FALSE, TRUE, 4230, '/card', ${T})`);
  await db.execute(sql`INSERT INTO follow_ups (id, contact_id, reason, due_at, status, created_at)
    VALUES ('f1', 'ada', 'Send the paper', ${T}, 'pending', ${T})`);
  await db.execute(sql`INSERT INTO activity_log (id, action, entity_type, entity_id, metadata, created_at)
    VALUES ('a1', 'contact.created', 'contact', 'ada', '{"source":"linkedin"}', ${T})`);
  await db.execute(sql`INSERT INTO profile_cards (id, draft, updated_at) VALUES ('default', '{"fullName":"Ada"}', ${T})`);
  await db.execute(sql`INSERT INTO content_items (id, url, url_norm, title, platform, created_at, updated_at)
    VALUES ('post1', 'https://example.com/a?utm=x', 'https://example.com/a', 'On engines', 'blog', ${T}, ${T})`);
  await db.execute(sql`INSERT INTO content_metrics (id, content_id, fetched_at, views, created_at)
    VALUES ('m1', 'post1', ${T}, 7, ${T})`);
  await db.execute(sql`INSERT INTO content_mentions (content_id, contact_id, context)
    VALUES ('post1', 'ada', 'quoted')`);
}

describeIfPg('PostgreSQL migration preservation (phase 22)', () => {
  afterAll(async () => {
    for (const name of created) {
      await withAdmin(async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [name]
        );
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      }).catch(() => {
        // Best effort cleanup of a throwaway database.
      });
    }
  }, 60_000);

  it('upgrades a v2.5-era database with every row preserved and backfilled', async () => {
    const name = await freshDatabase('v25');
    const conn = connect(name);
    const fixture = fixtureFolder(8);
    try {
      await runMigrations(conn, { force: true, migrationsFolder: fixture });
      await seedV25(conn);

      await runMigrations(conn, { force: true });

      const total = pendingMigrationTotal('postgresql');
      expect(await appliedMigrationCount(conn)).toBe(total);

      // Contacts, relationships, interactions.
      const contacts = await conn.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM contacts`);
      expect(Number(contacts.rows[0]?.n)).toBe(2);
      const ada = await conn.db.execute<{
        full_name: string;
        relationship_score: number;
        skills: string;
        workspace_id: string;
      }>(sql`SELECT full_name, relationship_score, skills, workspace_id FROM contacts WHERE id = 'ada'`);
      expect(ada.rows[0]?.full_name).toBe('Ada Lovelace');
      expect(ada.rows[0]?.relationship_score).toBeCloseTo(0.9);
      expect(JSON.parse(ada.rows[0]?.skills ?? '[]')).toEqual(['python', 'math']);
      expect(ada.rows[0]?.workspace_id).toBe('default');

      const edge = await conn.db.execute<{ status: string; workspace_id: string }>(
        sql`SELECT status, workspace_id FROM edges WHERE id = 'e1'`
      );
      expect(edge.rows[0]).toMatchObject({ status: 'pending', workspace_id: 'default' });

      const followup = await conn.db.execute<{ assigned_to: string | null; workspace_id: string }>(
        sql`SELECT assigned_to, workspace_id FROM follow_ups WHERE id = 'f1'`
      );
      expect(followup.rows[0]).toMatchObject({ assigned_to: null, workspace_id: 'default' });

      // Nothing left behind without a workspace.
      for (const table of [
        'contacts',
        'interactions',
        'edges',
        'events',
        'enrichments',
        'campaigns',
        'search_index',
        'profile_views',
        'follow_ups',
        'activity_log',
        'profile_cards',
        'content_items',
      ]) {
        const nulls = await conn.db.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE workspace_id IS NULL`
        );
        expect(Number(nulls.rows[0]?.n), `${table} has NULL workspace_id rows`).toBe(0);
      }

      // The generated tsvector derives from the preserved document.
      const hits = await conn.db.execute<{ id: string }>(
        sql`SELECT contact_id AS id FROM search_index WHERE search_vector @@ to_tsquery('english', 'analytical')`
      );
      expect(hits.rows.map((r) => r.id)).toEqual(['ada']);

      // Indexes rebuilt on the upgraded schema.
      const indexes = await conn.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`
      );
      const byName = new Map(indexes.rows.map((r) => [r.indexname, r.indexdef]));
      for (const expected of [
        'idx_contacts_workspace',
        'idx_search_index_vector',
        'idx_webhooks_workspace',
        'idx_profile_views_is_bot',
        'idx_followups_assigned_to',
      ]) {
        expect(byName.has(expected), `missing index ${expected}`).toBe(true);
      }
      expect(byName.get('idx_search_index_vector')).toMatch(/USING gin/i);

      // Idempotent re-run.
      await runMigrations(conn, { force: true });
      expect(await appliedMigrationCount(conn)).toBe(total);
    } finally {
      await conn.pool.end();
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps vault ciphertext byte-identical across a v3.0-era upgrade', async () => {
    const name = await freshDatabase('vault');
    const conn = connect(name);
    const fixture = fixtureFolder(11);
    try {
      await runMigrations(conn, { force: true, migrationsFolder: fixture });

      const ciphertext = Buffer.concat([
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 9),
        Buffer.from('ciphertext-body'),
      ]).toString('base64');
      await conn.db.execute(sql`INSERT INTO contacts (id, full_name, source, created_at, updated_at, workspace_id)
        VALUES ('ada', 'Ada Lovelace', 'test', ${T}, ${T}, 'default')`);
      await conn.db.execute(sql`INSERT INTO key_vault (id, workspace_id, user_id, key_name, ciphertext, last_four, created_at, updated_at)
        VALUES ('kv1', 'default', NULL, 'openai', ${ciphertext}, 'k-42', ${T}, ${T})`);

      await runMigrations(conn, { force: true });

      const row = await conn.db.execute<{ ciphertext: string; last_four: string }>(
        sql`SELECT ciphertext, last_four FROM key_vault WHERE id = 'kv1'`
      );
      expect(row.rows[0]).toEqual({ ciphertext, last_four: 'k-42' });
      expect(await appliedMigrationCount(conn)).toBe(pendingMigrationTotal('postgresql'));
    } finally {
      await conn.pool.end();
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);

  it('a failing migration leaves data and journal intact on PostgreSQL', async () => {
    const name = await freshDatabase('broken');
    const conn = connect(name);
    const broken = mkdtempSync(join(tmpdir(), 'netpro-pg-broken-'));
    try {
      await runMigrations(conn, { force: true });
      const total = pendingMigrationTotal('postgresql');
      await conn.db.execute(sql`INSERT INTO contacts (id, full_name, source, created_at, updated_at, workspace_id)
        VALUES ('keepme', 'Keep Me', 'test', ${T}, ${T}, 'default')`);

      const journal = readJournal();
      mkdirSync(join(broken, 'meta'));
      for (const entry of journal.entries) {
        copyFileSync(join(folder, `${entry.tag}.sql`), join(broken, `${entry.tag}.sql`));
      }
      const lastWhen = journal.entries[journal.entries.length - 1]!.when;
      writeFileSync(
        join(broken, 'meta/_journal.json'),
        JSON.stringify({
          ...journal,
          entries: [
            ...journal.entries,
            { idx: journal.entries.length, version: '6', when: lastWhen + 1, tag: '0015_broken', breakpoints: true },
          ],
        })
      );
      writeFileSync(join(broken, '0015_broken.sql'), 'THIS IS NOT VALID SQL;');

      await expect(runMigrations(conn, { migrationsFolder: broken })).rejects.toThrow();

      expect(await appliedMigrationCount(conn)).toBe(total);
      const kept = await conn.db.execute<{ full_name: string }>(
        sql`SELECT full_name FROM contacts WHERE id = 'keepme'`
      );
      expect(kept.rows[0]?.full_name).toBe('Keep Me');

      // Recovery: the next run with the correct folder heals.
      await runMigrations(conn, { migrationsFolder: resolveMigrationsFolder('postgresql') });
      expect(await appliedMigrationCount(conn)).toBe(total);
    } finally {
      await conn.pool.end();
      rmSync(broken, { recursive: true, force: true });
    }
  }, 120_000);
});
