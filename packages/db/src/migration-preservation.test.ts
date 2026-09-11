// Phase 22 — migration testing: existing users' data must survive upgrades.
//
// migrations.test.ts proves each migration in isolation (fresh apply, upgrade
// from its immediate predecessor, idempotency). This suite proves the whole
// journey an existing install actually takes:
//
//   1. A v2.5-era database (migrations 0000–0007, before workspaces) holding
//      representative rows in EVERY data table upgrades to the current schema
//      with every row preserved, every workspace_id backfilled, every index
//      rebuilt, and the FTS mirror queryable.
//   2. A v3.0-era database (0000–0010, workspaces + key vault + authorship)
//      upgrades with vault ciphertext byte-identical — "encrypted secrets
//      remain usable" is this byte-preservation composed with the crypto
//      round-trip in packages/core/src/crypto/vault.test.ts, which proves the
//      same master key decrypts the same bytes. Newer nullable columns
//      (assigned_to) default without touching existing rows.
//   3. A failing migration leaves data and the journal intact, and the next
//      run recovers — failures are never cached and never half-applied.
//
// The PostgreSQL half of this matrix lives in postgres.preservation.test.ts
// (same seed shapes, live server, gated on NETPRO_TEST_DATABASE_URL).

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
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
import * as schema from './schema.sqlite';
import { runMigrations } from './migrate';
import type { SqliteConn } from './index';

const folder = fileURLToPath(new URL('../migrations/sqlite', import.meta.url));

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as Journal;
}

/** Materialize a migrations folder holding journal entries with idx < maxIdx. */
function fixtureFolder(maxIdx: number): string {
  const journal = readJournal();
  const subset = journal.entries.filter((e) => e.idx < maxIdx);
  const expected = Array.from({ length: maxIdx }, (_, i) => i);
  expect(subset.map((e) => e.idx)).toEqual(expected);
  const dir = mkdtempSync(join(tmpdir(), 'netpro-preserve-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: subset }));
  for (const entry of subset) {
    copyFileSync(join(folder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

const T = '2026-01-01T00:00:00.000Z';

/** One representative row per v2.5-era data table. Raw SQL: the drizzle schema is the NEW one. */
function seedV25(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO contacts (id, full_name, email, company, role, source, tags, notes, relationship_score, interaction_count, created_at, updated_at, skills)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run('ada', 'Ada Lovelace', 'ada@example.com', 'Analytical Engines', 'Mathematician', 'linkedin', '["founder"]', 'Met at the engines conf.', 0.9, 5, T, T, '["python","math"]');
  sqlite
    .prepare(
      `INSERT INTO contacts (id, full_name, company, source, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('grace', 'Grace Hopper', 'Navy', 'linkedin', T, T);
  sqlite
    .prepare(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?)`
    )
    .run('gone', 'Gone Person', 'linkedin', T, T, T);

  sqlite
    .prepare(
      `INSERT INTO interactions (id, contact_id, type, subject, content, sentiment, occurred_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('i1', 'ada', 'meeting', 'Intro call', 'Talked compilers.', 'positive', T, T);
  sqlite
    .prepare(
      `INSERT INTO interactions (id, contact_id, type, occurred_at, created_at) VALUES (?,?,?,?,?)`
    )
    .run('i2', 'grace', 'note', T, T);

  sqlite
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, relation, strength, source, confidence, status, discovered_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run('e1', 'ada', 'grace', 'colleague', 0.8, 'csv', 0.9, 'pending', T, T);

  sqlite
    .prepare(
      `INSERT INTO events (id, name, location, starts_at, source, created_at) VALUES (?,?,?,?,?,?)`
    )
    .run('ev1', 'Engines Conf', 'London', T, 'csv', T);
  sqlite
    .prepare(
      `INSERT INTO event_attendees (event_id, contact_id, role, discovered_at) VALUES (?,?,?,?)`
    )
    .run('ev1', 'ada', 'speaker', T);

  sqlite
    .prepare(
      `INSERT INTO enrichments (id, contact_id, provider, data_type, raw_payload, confidence, fetched_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run('en1', 'ada', 'hunter', 'email', '{"email":"ada@example.com"}', 0.95, T);

  sqlite
    .prepare(
      `INSERT INTO campaigns (id, name, status, type, daily_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
    )
    .run('camp1', 'Q1 intros', 'active', 'drip', 10, T, T);
  sqlite
    .prepare(
      `INSERT INTO campaign_recipients (id, campaign_id, contact_id, status, current_step) VALUES (?,?,?,?,?)`
    )
    .run('cr1', 'camp1', 'grace', 'sent', 2);

  sqlite
    .prepare(
      `INSERT INTO search_index (contact_id, search_text, company_norm, embedding, embedding_model, content_hash, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run('ada', 'ada lovelace analytical engines mathematician', 'analytical engines', '[0.1,0.2]', 'test-model', 'hash-ada', T);

  sqlite
    .prepare(
      `INSERT INTO profile_views (id, viewer_ip, viewer_fingerprint, is_bot, is_owner_view, session_id, duration_ms, utm_source, viewed_page, viewed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run('v1', 'a1b2c3d4e5f60718', '90abcdef12345678', 0, 1, 'sess-1', 4230, 'linkedin', '/card', T);

  sqlite
    .prepare(
      `INSERT INTO follow_ups (id, contact_id, reason, due_at, status, created_at) VALUES (?,?,?,?,?,?)`
    )
    .run('f1', 'ada', 'Send the paper', T, 'pending', T);

  sqlite
    .prepare(
      `INSERT INTO activity_log (id, action, entity_type, entity_id, metadata, created_at) VALUES (?,?,?,?,?,?)`
    )
    .run('a1', 'contact.created', 'contact', 'ada', '{"source":"linkedin"}', T);

  sqlite
    .prepare(`INSERT INTO profile_cards (id, draft, updated_at) VALUES (?,?,?)`)
    .run('default', '{"fullName":"Ada"}', T);

  sqlite
    .prepare(
      `INSERT INTO content_items (id, url, url_norm, title, platform, tags, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run('post1', 'https://example.com/a?utm=x', 'https://example.com/a', 'On engines', 'blog', '["engines"]', 'manual', T, T);
  sqlite
    .prepare(
      `INSERT INTO content_metrics (id, content_id, fetched_at, views, created_at) VALUES (?,?,?,?,?)`
    )
    .run('m1', 'post1', T, 7, T);
  sqlite
    .prepare(
      `INSERT INTO content_mentions (content_id, contact_id, context) VALUES (?,?,?)`
    )
    .run('post1', 'ada', 'quoted');
}

describe('migration preservation (phase 22)', () => {
  it('upgrades a v2.5-era database with every row, edge, and index intact', () => {
    const sqlite = new Database(':memory:');
    const fixture = fixtureFolder(8);
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: fixture });
      seedV25(sqlite);

      migrate(db, { migrationsFolder: folder });

      const journal = readJournal();
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: journal.entries.length,
      });

      // ── Contacts, relationships, and interactions preserved ──
      expect(sqlite.prepare('SELECT count(*) AS n FROM contacts').get()).toEqual({ n: 3 });
      expect(sqlite.prepare('SELECT full_name, email, relationship_score, skills, workspace_id FROM contacts WHERE id = ?').get('ada')).toEqual({
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
        relationship_score: 0.9,
        skills: '["python","math"]',
        workspace_id: 'default',
      });
      // Soft-deleted rows are data too — the upgrade must not resurrect them.
      expect(sqlite.prepare('SELECT deleted_at FROM contacts WHERE id = ?').get('gone')).toEqual({
        deleted_at: T,
      });
      expect(sqlite.prepare('SELECT count(*) AS n FROM contacts WHERE workspace_id IS NULL').get()).toEqual({ n: 0 });

      expect(sqlite.prepare('SELECT subject, sentiment, workspace_id FROM interactions WHERE id = ?').get('i1')).toEqual({
        subject: 'Intro call',
        sentiment: 'positive',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT count(*) AS n FROM interactions').get()).toEqual({ n: 2 });

      // ── Graph data preserved, provenance columns untouched ──
      expect(sqlite.prepare('SELECT relation, strength, source, confidence, status, workspace_id FROM edges').get()).toEqual({
        relation: 'colleague',
        strength: 0.8,
        source: 'csv',
        confidence: 0.9,
        status: 'pending',
        workspace_id: 'default',
      });

      // ── Events, enrichment, campaigns preserved ──
      expect(sqlite.prepare('SELECT name, source, workspace_id FROM events').get()).toEqual({
        name: 'Engines Conf',
        source: 'csv',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT role, workspace_id FROM event_attendees').get()).toEqual({
        role: 'speaker',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT provider, confidence, workspace_id FROM enrichments').get()).toEqual({
        provider: 'hunter',
        confidence: 0.95,
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT status, type, daily_limit, workspace_id FROM campaigns').get()).toEqual({
        status: 'active',
        type: 'drip',
        daily_limit: 10,
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT status, current_step FROM campaign_recipients').get()).toEqual({
        status: 'sent',
        current_step: 2,
      });

      // ── Search index preserved and the FTS mirror rebuilt around it ──
      expect(
        sqlite.prepare('SELECT search_text, embedding_model, content_hash, workspace_id FROM search_index').get()
      ).toEqual({
        search_text: 'ada lovelace analytical engines mathematician',
        embedding_model: 'test-model',
        content_hash: 'hash-ada',
        workspace_id: 'default',
      });
      expect(
        sqlite.prepare('SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?').all('analytical')
      ).toEqual([{ contact_id: 'ada' }]);

      // ── Views, follow-ups, activity, cards, content preserved ──
      expect(
        sqlite.prepare('SELECT viewer_ip, is_owner_view, duration_ms, workspace_id FROM profile_views').get()
      ).toEqual({ viewer_ip: 'a1b2c3d4e5f60718', is_owner_view: 1, duration_ms: 4230, workspace_id: 'default' });
      expect(sqlite.prepare('SELECT reason, status, assigned_to, created_by_user, workspace_id FROM follow_ups').get()).toEqual({
        reason: 'Send the paper',
        status: 'pending',
        assigned_to: null,
        created_by_user: null,
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT action, entity_id, workspace_id FROM activity_log').get()).toEqual({
        action: 'contact.created',
        entity_id: 'ada',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT draft, workspace_id FROM profile_cards').get()).toEqual({
        draft: '{"fullName":"Ada"}',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT title, workspace_id FROM content_items').get()).toEqual({
        title: 'On engines',
        workspace_id: 'default',
      });
      expect(sqlite.prepare('SELECT views FROM content_metrics').get()).toEqual({ views: 7 });
      expect(sqlite.prepare('SELECT context FROM content_mentions').get()).toEqual({ context: 'quoted' });

      // ── Workspace bootstrap + indexes rebuilt ──
      expect(sqlite.prepare("SELECT id, slug FROM workspaces WHERE id = 'default'").get()).toEqual({
        id: 'default',
        slug: 'default',
      });
      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all()
        .map((r) => (r as { name: string }).name);
      for (const expected of [
        // CRM indexes (0002)
        'idx_contacts_relationship_score',
        'idx_interactions_contact',
        'idx_followups_due',
        // Edge provenance (0003)
        'idx_edges_status',
        // Hybrid search (0004)
        'idx_search_index_updated_at',
        // Profile views privacy (0006)
        'idx_profile_views_is_bot',
        // Content tracker (0007)
        'idx_content_items_platform',
        // Workspace scoping (0008)
        'idx_contacts_workspace',
        'idx_activity_log_workspace_time',
        // Authorship (0010)
        'idx_interactions_author',
        // Team collaboration (0012)
        'idx_followups_assigned_to',
        // Webhooks (0014)
        'idx_webhooks_workspace',
      ]) {
        expect(indexes).toContain(expected);
      }
      const triggers = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'contacts_fts_%' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(triggers).toEqual(['contacts_fts_ad', 'contacts_fts_ai', 'contacts_fts_au']);

      // ── Re-running is a no-op: same rows, same journal ──
      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare('SELECT count(*) AS n FROM contacts').get()).toEqual({ n: 3 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: journal.entries.length,
      });
    } finally {
      sqlite.close();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps vault ciphertext and authorship byte-identical across a v3.0-era upgrade', () => {
    const sqlite = new Database(':memory:');
    const fixture = fixtureFolder(11);
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: fixture });

      // The vault row is opaque bytes to the migrator: 32 bytes of IV+tag and
      // a ciphertext body, exactly as encryptKey() lays them out. Later
      // migrations must carry them through untouched; decryptability of the
      // carried bytes is proven by the crypto round-trip suite, which uses the
      // same master key and principal derivation, not by reimplementing AES
      // here.
      const ciphertext = Buffer.concat([
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 9),
        Buffer.from('ciphertext-body'),
      ]).toString('base64');
      sqlite
        .prepare(
          `INSERT INTO contacts (id, full_name, source, created_at, updated_at, workspace_id) VALUES (?,?,?,?,?,?)`
        )
        .run('ada', 'Ada Lovelace', 'test', T, T, 'default');
      sqlite
        .prepare(
          `INSERT INTO key_vault (id, workspace_id, user_id, key_name, ciphertext, last_four, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run('kv1', 'default', null, 'openai', ciphertext, 'k-42', T, T);
      sqlite
        .prepare(
          `INSERT INTO interactions (id, contact_id, type, occurred_at, created_at, workspace_id, created_by_user)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run('i1', 'ada', 'note', T, T, 'default', 'user-1');
      sqlite
        .prepare(
          `INSERT INTO follow_ups (id, contact_id, due_at, created_at, workspace_id, created_by_user)
           VALUES (?,?,?,?,?,?)`
        )
        .run('f1', 'ada', T, T, 'default', 'user-1');

      migrate(db, { migrationsFolder: folder });

      expect(sqlite.prepare('SELECT ciphertext, last_four FROM key_vault').get()).toEqual({
        ciphertext,
        last_four: 'k-42',
      });
      expect(sqlite.prepare('SELECT created_by_user FROM interactions').get()).toEqual({
        created_by_user: 'user-1',
      });
      // 0012 adds assignment without disturbing existing rows.
      expect(
        sqlite.prepare('SELECT created_by_user, assigned_to FROM follow_ups').get()
      ).toEqual({ created_by_user: 'user-1', assigned_to: null });
      // 0013/0014 land empty and indexed.
      expect(sqlite.prepare('SELECT count(*) AS n FROM plugins').get()).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM webhooks').get()).toEqual({ n: 0 });

      const journal = readJournal();
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: journal.entries.length,
      });
      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare('SELECT ciphertext FROM key_vault').get()).toEqual({ ciphertext });
    } finally {
      sqlite.close();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('a failing migration leaves data and journal intact, and the next run recovers', async () => {
    const sqlite = new Database(':memory:');
    const broken = mkdtempSync(join(tmpdir(), 'netpro-broken-'));
    try {
      const db = drizzle(sqlite, { schema });
      const conn: SqliteConn = { dialect: 'sqlite', db, schema };
      migrate(db, { migrationsFolder: folder });
      sqlite
        .prepare(
          'INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)'
        )
        .run('keepme', 'Keep Me', 'test', T, T);
      const journal = readJournal();
      const appliedBefore = (
        sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }
      ).n;
      expect(appliedBefore).toBe(journal.entries.length);

      // A future migration with invalid SQL — the shape of a bad deploy.
      mkdirSync(join(broken, 'meta'));
      for (const entry of journal.entries) {
        copyFileSync(join(folder, `${entry.tag}.sql`), join(broken, `${entry.tag}.sql`));
      }
      const brokenTag = '0015_broken';
      // Drizzle decides what is pending by comparing the journal `when`
      // against the last applied row — not by counting entries. The broken
      // entry must sort after every committed one or the migrator no-ops.
      const lastWhen = journal.entries[journal.entries.length - 1]!.when;
      writeFileSync(
        join(broken, 'meta/_journal.json'),
        JSON.stringify({
          ...journal,
          entries: [
            ...journal.entries,
            { idx: journal.entries.length, version: '6', when: lastWhen + 1, tag: brokenTag, breakpoints: true },
          ],
        })
      );
      writeFileSync(join(broken, `${brokenTag}.sql`), 'THIS IS NOT VALID SQL;');

      await expect(runMigrations(conn, { migrationsFolder: broken })).rejects.toThrow();

      // Nothing half-applied: same journal, same rows.
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: appliedBefore,
      });
      expect(sqlite.prepare('SELECT full_name FROM contacts').get()).toEqual({
        full_name: 'Keep Me',
      });

      // The failure is not cached: the very next run (correct folder) heals.
      await runMigrations(conn);
      expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
        n: appliedBefore,
      });
      expect(sqlite.prepare('SELECT full_name FROM contacts').get()).toEqual({
        full_name: 'Keep Me',
      });
    } finally {
      sqlite.close();
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
