import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@netpro/db/src/schema.pg";
import { runMigrations, type PgConn } from "@netpro/db";
import {
  listVaultKeys,
  saveVaultKey,
  resolveVaultKey,
  removeVaultKey,
} from "./vault";

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const dbName = `netpro_vault_${Date.now().toString(36)}`;
const master = "a".repeat(40);
const scope = {
  workspaceId: "default",
  userId: "alice",
  role: "admin" as const,
};
async function admin(query: string) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

describe.skipIf(!adminUrl)("vault against live PostgreSQL", () => {
  let conn: PgConn;
  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString() });
    conn = {
      dialect: "postgresql",
      db: drizzle(pool, { schema }),
      schema,
      pool,
    };
    await runMigrations(conn, { force: true });
    await conn.db.insert(schema.users).values([
      { id: "alice", email: "alice@example.test" },
      { id: "bob", email: "bob@example.test" },
    ]);
    await conn.db
      .insert(schema.workspaces)
      .values({ id: "other", slug: "other", name: "Other" });
  });
  afterAll(async () => {
    await conn?.pool.end();
    await admin(`DROP DATABASE IF EXISTS "${dbName}"`);
  });
  it("migrates idempotently and upserts both partial-index principals under concurrent writes", async () => {
    await runMigrations(conn, { force: true });
    for (const target of ["personal", "workspace"] as const) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          saveVaultKey(
            conn,
            scope,
            target,
            "outreach.openai",
            `${target}-secret`,
            master,
          ),
        ),
      );
    }
    expect(await listVaultKeys(conn, scope)).toHaveLength(2);
    const env = { ENCRYPTION_MASTER_KEY: master, OPENAI_API_KEY: "env-secret" };
    expect(await resolveVaultKey(conn, scope, "outreach.openai", env)).toBe(
      "personal-secret",
    );
    expect(
      await resolveVaultKey(
        conn,
        { ...scope, userId: "bob" },
        "outreach.openai",
        env,
      ),
    ).toBe("workspace-secret");
    expect(
      await resolveVaultKey(
        conn,
        { ...scope, workspaceId: "other" },
        "outreach.openai",
        env,
      ),
    ).toBe("env-secret");
    expect(
      (await listVaultKeys(conn, { ...scope, userId: "bob" })).some(
        (k) => k.userId === "alice",
      ),
    ).toBe(false);
    await removeVaultKey(conn, scope, "personal", "outreach.openai", master);
    expect(await resolveVaultKey(conn, scope, "outreach.openai", env)).toBe(
      "workspace-secret",
    );
    const rows = await conn.db.select().from(schema.keyVault);
    expect(JSON.stringify(rows)).not.toContain("workspace-secret");
    await expect(
      resolveVaultKey(conn, scope, "outreach.openai", {
        ...env,
        ENCRYPTION_MASTER_KEY: "b".repeat(40),
      }),
    ).rejects.toThrow("Unable to decrypt");
  });
});
