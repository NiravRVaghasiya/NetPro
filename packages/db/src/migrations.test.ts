import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.sqlite";

const folder = fileURLToPath(new URL("../migrations/sqlite", import.meta.url));

describe("edge provenance migration (v2.0 phase 1)", () => {
  it("adds edge columns, indexes, and events tables on a fresh database", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });
      const cols = sqlite
        .prepare("PRAGMA table_info(edges)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(cols).toEqual(
        expect.arrayContaining(["source", "confidence", "status"]),
      );
      const names = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_edges_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(names).toEqual(
        expect.arrayContaining([
          "idx_edges_source",
          "idx_edges_target",
          "idx_edges_relation",
          "idx_edges_confidence",
          "idx_edges_status",
        ]),
      );
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events','event_attendees')",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort();
      expect(tables).toEqual(["event_attendees", "events"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("crm indexes migration (v1.5)", () => {
  it("creates every CRM index on a fresh database", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });
      const names = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(names).toEqual(
        expect.arrayContaining([
          "idx_contacts_relationship_score",
          "idx_contacts_last_interaction",
          "idx_interactions_contact",
          "idx_interactions_campaign",
          "idx_followups_due",
          "idx_followups_contact",
          "idx_campaigns_status",
          "idx_campaign_recipients_status",
          "idx_campaign_recipients_scheduled",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("profile card migration", () => {
  it("upgrades an existing database without changing contacts and remains idempotent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "netpro-migration-"));
    const sqlite = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(join(folder, "meta/_journal.json"), "utf8"),
      ) as {
        entries: Array<{ tag: string }>;
      };
      const first = journal.entries[0]!;
      mkdirSync(join(temporary, "meta"));
      writeFileSync(
        join(temporary, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: [first] }),
      );
      copyFileSync(
        join(folder, `${first.tag}.sql`),
        join(temporary, `${first.tag}.sql`),
      );
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: temporary });
      // This fixture intentionally has only the first migration applied, so
      // use raw SQL rather than the current schema (which includes later
      // additive columns such as contacts.skills).
      sqlite
        .prepare("INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("existing", "Keep this contact", "test", "2026-01-01", "2026-01-01");
      db.insert(schema.users)
        .values({ id: "owner", email: "owner@example.com" })
        .run();

      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare("SELECT full_name FROM contacts").get()).toEqual({
        full_name: "Keep this contact",
      });
      expect(sqlite.prepare("SELECT id FROM user").get()).toEqual({
        id: "owner",
      });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM profile_cards").get(),
      ).toEqual({ n: 0 });
      db.insert(schema.profileCards)
        .values({ id: "default", draft: '{"fullName":"Ada"}' })
        .run();
      migrate(db, { migrationsFolder: folder });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM profile_cards").get(),
      ).toEqual({ n: 1 });
      // Asserted against the journal (not a literal) so additive migrations —
      // like the v1.5 CRM indexes — don't break the idempotency claim.
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: journal.entries.length });
    } finally {
      sqlite.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("hybrid search migration (v2.0 phase 4)", () => {
  it("adds the search_index columns, the FTS5 table, and its sync triggers", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });

      const cols = sqlite
        .prepare("PRAGMA table_info(search_index)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(cols).toEqual(
        expect.arrayContaining([
          "embedding",
          "embedding_model",
          "embedding_dim",
          "embedding_updated_at",
          "content_hash",
        ]),
      );

      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts_fts'",
          )
          .all(),
      ).toEqual([{ name: "contacts_fts" }]);

      const triggers = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'contacts_fts_%' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(triggers).toEqual([
        "contacts_fts_ad",
        "contacts_fts_ai",
        "contacts_fts_au",
      ]);

      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_search_index_updated_at'",
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("keeps FTS5 in step with every search_index write", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });
      sqlite
        .prepare(
          "INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("c1", "Jane Doe", "test", "n", "n");

      const match = (term: string) =>
        sqlite
          .prepare("SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?")
          .all(term)
          .map((r) => (r as { contact_id: string }).contact_id);

      sqlite
        .prepare(
          "INSERT INTO search_index (contact_id, search_text, updated_at) VALUES (?,?,?)",
        )
        .run("c1", "jane doe stripe payments", "n");
      expect(match("payments")).toEqual(["c1"]);

      sqlite
        .prepare("UPDATE search_index SET search_text = ? WHERE contact_id = ?")
        .run("jane doe vercel edge", "c1");
      expect(match("payments")).toEqual([]);
      expect(match("vercel")).toEqual(["c1"]);

      sqlite.prepare("DELETE FROM search_index WHERE contact_id = ?").run("c1");
      expect(match("vercel")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("backfills the FTS mirror when upgrading a database that already has index rows", () => {
    // The realistic upgrade path: 0003 applied, rows written by a future
    // producer, then 0004 lands. The mirror must not start out empty.
    const temporary = mkdtempSync(join(tmpdir(), "netpro-fts-upgrade-"));
    const sqlite = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(join(folder, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ tag: string }> };
      const upTo0003 = journal.entries.slice(0, 4);
      mkdirSync(join(temporary, "meta"));
      writeFileSync(
        join(temporary, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: upTo0003 }),
      );
      for (const entry of upTo0003) {
        copyFileSync(
          join(folder, `${entry.tag}.sql`),
          join(temporary, `${entry.tag}.sql`),
        );
      }

      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: temporary });
      sqlite
        .prepare(
          "INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("legacy", "Ada Lovelace", "test", "n", "n");
      sqlite
        .prepare(
          "INSERT INTO search_index (contact_id, search_text, updated_at) VALUES (?,?,?)",
        )
        .run("legacy", "ada lovelace analytical engine", "n");

      migrate(db, { migrationsFolder: folder });

      expect(
        sqlite
          .prepare("SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?")
          .all("analytical"),
      ).toEqual([{ contact_id: "legacy" }]);
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: journal.entries.length });
    } finally {
      sqlite.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("skills migration (v2.0 phase 5)", () => {
  it("adds the nullable contacts.skills column and leaves existing rows untouched", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });
      const skills = sqlite
        .prepare("PRAGMA table_info(contacts)")
        .all()
        .find((r) => (r as { name: string }).name === "skills") as
        | { type: string; notnull: number; dflt_value: unknown }
        | undefined;
      expect(skills).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });

      sqlite
        .prepare(
          "INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("c1", "Jane Doe", "test", "n", "n");
      expect(sqlite.prepare("SELECT skills FROM contacts WHERE id = 'c1'").get()).toEqual({
        skills: null,
      });
      // JSON-mode column: an array round-trips through drizzle as an array.
      db.update(schema.contacts)
        .set({ skills: ["python", "kubernetes"] })
        .run();
      expect(sqlite.prepare("SELECT skills FROM contacts WHERE id = 'c1'").get()).toEqual({
        skills: '["python","kubernetes"]',
      });
      expect(db.select({ skills: schema.contacts.skills }).from(schema.contacts).get()).toEqual({
        skills: ["python", "kubernetes"],
      });
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a pre-0005 database in place, keeping the contact and the search index", () => {
    const temporary = mkdtempSync(join(tmpdir(), "netpro-migration-0005-"));
    const sqlite = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(join(folder, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      // Up to but not including 0005 — later migrations (0006, 0007, …)
      // must not leak into the pre-upgrade fixture. Asserted as explicit
      // idxs so the next migration cannot break this test again.
      const upTo0004 = journal.entries.filter((e) => e.idx < 5);
      expect(upTo0004.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4]);
      mkdirSync(join(temporary, "meta"));
      writeFileSync(
        join(temporary, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: upTo0004 }),
      );
      for (const entry of upTo0004) {
        copyFileSync(
          join(folder, `${entry.tag}.sql`),
          join(temporary, `${entry.tag}.sql`),
        );
      }

      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: temporary });
      expect(
        sqlite
          .prepare("PRAGMA table_info(contacts)")
          .all()
          .some((r) => (r as { name: string }).name === "skills"),
      ).toBe(false);
      sqlite
        .prepare(
          "INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("legacy", "Ada Lovelace", "test", "n", "n");
      sqlite
        .prepare(
          "INSERT INTO search_index (contact_id, search_text, updated_at) VALUES (?,?,?)",
        )
        .run("legacy", "ada lovelace analytical engine", "n");

      migrate(db, { migrationsFolder: folder });

      expect(sqlite.prepare("SELECT full_name, skills FROM contacts").get()).toEqual({
        full_name: "Ada Lovelace",
        skills: null,
      });
      expect(
        sqlite
          .prepare("SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH ?")
          .all("analytical"),
      ).toEqual([{ contact_id: "legacy" }]);
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: journal.entries.length });
      // Re-running is a no-op: the column is not added twice.
      migrate(db, { migrationsFolder: folder });
      expect(
        sqlite
          .prepare("PRAGMA table_info(contacts)")
          .all()
          .filter((r) => (r as { name: string }).name === "skills"),
      ).toHaveLength(1);
    } finally {
      sqlite.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("profile views privacy migration (v2.5 phase 1)", () => {
  it("adds the hardened columns and indexes on a fresh database", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });

      const cols = sqlite
        .prepare("PRAGMA table_info(profile_views)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(cols).toEqual(
        expect.arrayContaining([
          // Kept from 0000, now holding a hashed value (never a raw IP).
          "viewer_ip",
          "viewer_fingerprint",
          "is_bot",
          "is_owner_view",
          "session_id",
          "duration_ms",
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "viewed_card_id",
        ]),
      );
      // The flags are NOT NULL and default false, so an insert that says
      // nothing about them still yields 0 — analytics filters can rely on it.
      sqlite
        .prepare(
          "INSERT INTO profile_views (id, viewed_page, viewed_at) VALUES (?, ?, ?)",
        )
        .run("v1", "/card", "2026-09-08T00:00:00.000Z");
      expect(
        sqlite
          .prepare("SELECT is_bot, is_owner_view FROM profile_views WHERE id = ?")
          .get("v1"),
      ).toEqual({ is_bot: 0, is_owner_view: 0 });

      // Typed drizzle round-trip: booleans and the new free-form columns.
      db.insert(schema.profileViews)
        .values({
          id: "v2",
          viewerIp: "a1b2c3d4e5f60718",
          viewerFingerprint: "90abcdef12345678",
          isBot: false,
          isOwnerView: true,
          sessionId: "sess-1",
          durationMs: 4230,
          utmSource: "linkedin",
          utmMedium: "social",
          utmCampaign: "launch",
          viewedCardId: "default",
          viewedPage: "/card",
        })
        .run();
      expect(
        db
          .select({
            isBot: schema.profileViews.isBot,
            isOwnerView: schema.profileViews.isOwnerView,
            durationMs: schema.profileViews.durationMs,
            utmCampaign: schema.profileViews.utmCampaign,
          })
          .from(schema.profileViews)
          .where(eq(schema.profileViews.id, "v2"))
          .get(),
      ).toEqual({
        isBot: false,
        isOwnerView: true,
        durationMs: 4230,
        utmCampaign: "launch",
      });

      const names = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_profile_views_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort();
      expect(names).toEqual(
        expect.arrayContaining([
          "idx_profile_views_time",
          "idx_profile_views_resolved",
          "idx_profile_views_page",
          "idx_profile_views_fingerprint_time",
          "idx_profile_views_is_bot",
        ]),
      );
      // The is_bot index is partial — analytics scans only non-bot rows.
      const isBotIndex = sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_profile_views_is_bot'",
        )
        .get() as { sql: string };
      expect(isBotIndex.sql).toContain("is_bot");
      expect(isBotIndex.sql).toContain("WHERE");
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a pre-0006 database in place, blanking raw IPs, and is idempotent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "netpro-migration-0006-"));
    const sqlite = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(join(folder, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      // Idx-based (not tag-prefix): a later migration must not leak into
      // the pre-upgrade fixture the way 0007 did before this fix.
      const upTo0005 = journal.entries.filter((e) => e.idx < 6);
      expect(upTo0005.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4, 5]);
      mkdirSync(join(temporary, "meta"));
      writeFileSync(
        join(temporary, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: upTo0005 }),
      );
      for (const entry of upTo0005) {
        copyFileSync(
          join(folder, `${entry.tag}.sql`),
          join(temporary, `${entry.tag}.sql`),
        );
      }

      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: temporary });
      // A legacy row written before the privacy hardening: raw IP, no flags.
      sqlite
        .prepare(
          "INSERT INTO profile_views (id, viewer_ip, viewer_agent, viewed_page, viewed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "legacy",
          "203.0.113.42",
          "Mozilla/5.0 (legacy)",
          "/card",
          "2026-09-01T00:00:00.000Z",
        );

      migrate(db, { migrationsFolder: folder });

      // The row survives, but its raw IP does not: 0006 blanks legacy values
      // because the migration cannot hash them without the operator's salt.
      expect(sqlite.prepare("SELECT id FROM profile_views").all()).toEqual([
        { id: "legacy" },
      ]);
      expect(
        sqlite.prepare("SELECT viewer_ip, is_bot, is_owner_view FROM profile_views").get(),
      ).toEqual({ viewer_ip: null, is_bot: 0, is_owner_view: 0 });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: journal.entries.length });

      // Re-running is a no-op: no duplicate columns, no double-index errors.
      migrate(db, { migrationsFolder: folder });
      expect(
        sqlite
          .prepare("PRAGMA table_info(profile_views)")
          .all()
          .filter((r) => (r as { name: string }).name === "is_bot"),
      ).toHaveLength(1);
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_profile_views_is_bot'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      sqlite.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("content tracker migration (v2.5 phase 4)", () => {
  it("creates the content tables, the url_norm unique key and every index", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: folder });

      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('content_items','content_metrics','content_mentions')",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort();
      expect(tables).toEqual(["content_items", "content_mentions", "content_metrics"]);

      const itemCols = sqlite
        .prepare("PRAGMA table_info(content_items)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(itemCols).toEqual(
        expect.arrayContaining([
          "url",
          "url_norm",
          "title",
          "platform",
          "type",
          "published_at",
          "author",
          "tags",
          "summary",
          "source",
        ]),
      );

      const names = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_content_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort();
      expect(names).toEqual(
        expect.arrayContaining([
          "idx_content_items_platform",
          "idx_content_items_published",
          "idx_content_metrics_item_time",
          "idx_content_metrics_time",
          "idx_content_mentions_contact",
          "idx_content_mentions_content",
        ]),
      );

      // The dedupe key is genuinely unique: a second row with the same
      // normalized URL fails at the database, not just in the repository.
      sqlite
        .prepare(
          "INSERT INTO content_items (id, url, url_norm, title, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("c1", "https://example.com/a?utm_source=x", "https://example.com/a", "A", "blog", "n", "n");
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO content_items (id, url, url_norm, title, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("c2", "https://example.com/a", "https://example.com/a", "A again", "blog", "n", "n"),
      ).toThrow(/UNIQUE constraint failed/);

      // Typed drizzle round-trip, including the JSON-mode columns.
      db.insert(schema.contentMetrics)
        .values({ id: "m1", contentId: "c1", fetchedAt: "2026-09-08T00:00:00.000Z", views: 7 })
        .run();
      db.update(schema.contentItems).set({ tags: ["postgres"] }).run();
      expect(
        db.select({ tags: schema.contentItems.tags }).from(schema.contentItems).get(),
      ).toEqual({ tags: ["postgres"] });
      expect(
        db
          .select({ views: schema.contentMetrics.views })
          .from(schema.contentMetrics)
          .where(eq(schema.contentMetrics.id, "m1"))
          .get(),
      ).toEqual({ views: 7 });
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a pre-0007 database in place and is idempotent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "netpro-migration-0007-"));
    const sqlite = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(join(folder, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      const upTo0006 = journal.entries.filter((e) => e.idx < 7);
      expect(upTo0006.map((e) => e.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      mkdirSync(join(temporary, "meta"));
      writeFileSync(
        join(temporary, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: upTo0006 }),
      );
      for (const entry of upTo0006) {
        copyFileSync(
          join(folder, `${entry.tag}.sql`),
          join(temporary, `${entry.tag}.sql`),
        );
      }

      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: temporary });
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_items'")
          .all(),
      ).toEqual([]);
      sqlite
        .prepare(
          "INSERT INTO contacts (id, full_name, source, created_at, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("legacy", "Ada Lovelace", "test", "n", "n");

      migrate(db, { migrationsFolder: folder });

      // The contact survives and the new tables exist.
      expect(sqlite.prepare("SELECT full_name FROM contacts").get()).toEqual({
        full_name: "Ada Lovelace",
      });
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_items'")
          .all(),
      ).toEqual([{ name: "content_items" }]);
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: journal.entries.length });

      // Re-running is a no-op: no duplicate tables, no double-index errors.
      migrate(db, { migrationsFolder: folder });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'content_items'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      sqlite.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
