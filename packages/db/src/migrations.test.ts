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
      db.insert(schema.contacts)
        .values({
          id: "existing",
          fullName: "Keep this contact",
          source: "test",
        })
        .run();
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
