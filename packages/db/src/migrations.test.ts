import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
        .prepare("INSERT INTO contacts (id, full_name, source) VALUES (?, ?, ?)")
        .run("existing", "Keep this contact", "test");
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
