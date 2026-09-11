// packages/core/src/scan/index.test.ts
//
// Phase 16 — the one scan implementation, tested where it lives.
//
// These tests prove the property the phase is about: the sweep is real work
// (reindex + enrichment + graph), it is identical for CLI and server because
// it lives in core, and it completes — reporting honest numbers — with no
// external provider configured (Phase 17).

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { SqliteConn } from "@netpro/db";
import { runScan, DEFAULT_SCAN_SOURCE, type ScanProgressUpdate } from "./index";

function insertContact(sqlite: Database.Database, id: string, fullName: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO contacts (id, workspace_id, full_name, company, role, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, "default", fullName, "Acme", "Engineer", "test", now, now);
}

function insertEdge(sqlite: Database.Database, id: string, sourceId: string, targetId: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO edges (id, workspace_id, source_id, target_id, relation, source, status, confidence, discovered_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, "default", sourceId, targetId, "colleague", "test", "confirmed", 1, now, now);
}

/** A database with no tables at all — the "unmigrated" degradation path. */
function unmigratedConn(): SqliteConn {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  return { dialect: "sqlite", db, schema };
}

describe("runScan", () => {
  let handle: ReturnType<typeof createTestSqliteConn>;

  beforeEach(() => {
    handle = createTestSqliteConn();
  });

  it("completes on an empty database with no provider configured", async () => {
    const result = await runScan(handle.conn, { env: {} });

    expect(result.source).toBe(DEFAULT_SCAN_SOURCE);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    // No provider → enrichment is skipped, not failed.
    expect(result.enrichment.configured).toBe(false);
    expect(result.enrichment.enriched).toBe(0);
    expect(result.enrichment.error).toBeNull();
    // Offline capabilities are unaffected (Phase 17).
    expect(result.providers?.capabilities.keywordSearch).toBe("available");
    expect(result.providers?.capabilities.semanticSearch).toBe("disabled");
  });

  it("reindexes contacts and reports the real index numbers", async () => {
    insertContact(handle.sqlite, "s1", "Jane Doe");
    insertContact(handle.sqlite, "s2", "John Smith");
    insertEdge(handle.sqlite, "e1", "s1", "s2");

    const result = await runScan(handle.conn, { env: {} });

    expect(result.index).toMatchObject({ scanned: 2, indexed: 2, skipped: 0 });
    expect(result.index.keywordIndexAvailable).toBe(true);
    expect(result.processed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.newContacts).toBe(2);
    // Graph analysis ran: one confirmed edge, communities detected.
    expect(result.relationships).toBe(1);
    expect(result.relationshipsDiscovered).toBeGreaterThanOrEqual(1);
    expect(result.graph).toMatchObject({ edges: 1, nodes: 2 });
  });

  it("emits the whole progress ladder, monotonically, ending at 100", async () => {
    insertContact(handle.sqlite, "s1", "Jane Doe");
    const updates: ScanProgressUpdate[] = [];

    const result = await runScan(handle.conn, {
      env: {},
      onProgress: (u) => updates.push(u),
    });

    expect(updates.length).toBeGreaterThanOrEqual(6);
    expect(updates[0]).toMatchObject({ stage: "queued", progress: 0 });
    expect(updates.at(-1)).toMatchObject({ stage: "completed", progress: 100 });

    const percentages = updates.map((u) => u.progress);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages).toContain(15);
    expect(percentages).toContain(40);
    expect(percentages).toContain(70);
    expect(percentages).toContain(90);
    // Every update carries a human-readable stage message.
    for (const u of updates) expect(u.message.length).toBeGreaterThan(0);
    expect(result.completedAt).toBeTruthy();
  });

  it("reports the source the caller named", async () => {
    const result = await runScan(handle.conn, { env: {}, source: "cli" });
    expect(result.source).toBe("cli");

    const fallback = await runScan(handle.conn, { env: {}, source: "   " });
    expect(fallback.source).toBe(DEFAULT_SCAN_SOURCE);
  });

  it("skips enrichment when the caller opts out, even with a key present", async () => {
    insertContact(handle.sqlite, "s1", "Jane Doe");

    const result = await runScan(handle.conn, {
      env: { HUNTER_API_KEY: "test-key-not-real" },
      enrich: false,
    });

    expect(result.enrichment.enriched).toBe(0);
    expect(result.enrichment.progress).toBe(0);
    // Not part of this scan, so it is reported as not configured rather than
    // as a configured run that happened to find nothing.
    expect(result.enrichment.configured).toBe(false);
    expect(result.enrichment.providers).toEqual([]);
    // The rest of the sweep still ran.
    expect(result.index.scanned).toBe(1);
  });

  it("survives an unmigrated database instead of failing the scan", async () => {
    const conn = unmigratedConn();
    const result = await runScan(conn, { env: {} });

    expect(result.index).toMatchObject({ scanned: 0, indexed: 0 });
    expect(result.index.keywordIndexAvailable).toBe(false);
    expect(result.relationships).toBe(0);
    expect(result.communities).toBe(0);
    expect(result.enrichment.error).toBeNull();
  });
});
