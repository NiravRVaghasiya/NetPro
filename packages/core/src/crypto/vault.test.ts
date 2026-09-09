import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { WorkspaceScope } from "../workspaces";
import { decryptKey, encryptKey, vaultPrincipal } from "./key-vault";
import {
  listVaultKeys,
  removeVaultKey,
  resolveVaultKey,
  saveVaultKey,
} from "./vault";

const master = "a".repeat(40);
const env = { ENCRYPTION_MASTER_KEY: master, OPENAI_API_KEY: "env-secret" };
const a: WorkspaceScope = {
  workspaceId: "default",
  userId: "alice",
  role: "admin",
};
const bob = { ...a, userId: "bob", role: "member" as const };
let fixture: ReturnType<typeof createTestSqliteConn>;
beforeEach(() => {
  fixture = createTestSqliteConn();
  fixture.sqlite.exec(
    `INSERT INTO "user" (id,email) VALUES ('alice','alice@example.test'), ('bob','bob@example.test'); INSERT INTO workspaces (id,name,slug,created_at) VALUES ('other','Other','other','2026-09-09');`,
  );
});
afterEach(() => fixture.sqlite.close());

describe("authenticated encryption", () => {
  it("round trips with random IVs and rejects swapped slots, principals, masters and tampering", () => {
    const p = vaultPrincipal("default", "alice", "outreach.openai");
    const ct = encryptKey("secret-value", master, p);
    expect(decryptKey(ct, master, p)).toBe("secret-value");
    expect(encryptKey("secret-value", master, p)).not.toBe(ct);
    for (const principal of [
      vaultPrincipal("other", "alice", "outreach.openai"),
      vaultPrincipal("default", "bob", "outreach.openai"),
      vaultPrincipal("default", "alice", "content.github"),
    ]) {
      expect(() => decryptKey(ct, master, principal)).toThrow(
        "Unable to decrypt",
      );
    }
    expect(() => decryptKey(ct, "b".repeat(40), p)).toThrow(
      "Unable to decrypt",
    );
    const damaged = Buffer.from(ct, "base64");
    damaged[28] = damaged[28]! ^ 1;
    expect(() => decryptKey(damaged.toString("base64"), master, p)).toThrow(
      "Unable to decrypt",
    );
    expect(() => decryptKey("bad", master, p)).toThrow("Unable to decrypt");
    expect(() => encryptKey("secret", undefined, p)).toThrow("read-only");
  });
});

describe("migrated vault repository", () => {
  it("resolves personal > workspace > env and never exposes secrets in metadata", async () => {
    const { conn, sqlite } = fixture;
    expect(await resolveVaultKey(conn, a, "outreach.openai", env)).toBe(
      "env-secret",
    );
    await saveVaultKey(
      conn,
      a,
      "workspace",
      "outreach.openai",
      "workspace-secret",
      master,
    );
    await saveVaultKey(
      conn,
      a,
      "personal",
      "outreach.openai",
      "personal-secret",
      master,
    );
    expect(await resolveVaultKey(conn, a, "outreach.openai", env)).toBe(
      "personal-secret",
    );
    expect(await resolveVaultKey(conn, bob, "outreach.openai", env)).toBe(
      "workspace-secret",
    );
    expect(
      await resolveVaultKey(
        conn,
        { ...a, workspaceId: "other" },
        "outreach.openai",
        env,
      ),
    ).toBe("env-secret");
    const metadata = await listVaultKeys(conn, a);
    expect(metadata.find((k) => k.userId === "alice")?.lastUsedAt).toBeTruthy();
    expect(JSON.stringify(metadata)).not.toContain("ciphertext");
    expect(
      JSON.stringify(sqlite.prepare("SELECT * FROM key_vault").all()),
    ).not.toContain("personal-secret");
    expect(JSON.stringify(metadata)).not.toContain("personal-secret");
    expect(
      (await listVaultKeys(conn, bob)).some((k) => k.userId === "alice"),
    ).toBe(false);
    await removeVaultKey(conn, a, "personal", "outreach.openai", master);
    expect(await resolveVaultKey(conn, a, "outreach.openai", env)).toBe(
      "workspace-secret",
    );
  });

  it("replaces both personal and NULL-principal slots atomically without duplicates", async () => {
    for (const target of ["personal", "workspace"] as const) {
      await saveVaultKey(
        fixture.conn,
        a,
        target,
        "outreach.openai",
        "first-secret",
        master,
      );
      await saveVaultKey(
        fixture.conn,
        a,
        target,
        "outreach.openai",
        "second-secret",
        master,
      );
    }
    expect(await listVaultKeys(fixture.conn, a)).toHaveLength(2);
    expect(await resolveVaultKey(fixture.conn, a, "outreach.openai", env)).toBe(
      "second-secret",
    );
    expect(
      await resolveVaultKey(fixture.conn, bob, "outreach.openai", env),
    ).toBe("second-secret");
  });

  it("enforces write roles, slot bounds, read-only fallback, and fails closed on wrong master", async () => {
    const { conn } = fixture;
    await expect(
      saveVaultKey(
        conn,
        bob,
        "workspace",
        "outreach.openai",
        "secret-value",
        master,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      saveVaultKey(
        conn,
        { ...bob, role: "viewer" },
        "personal",
        "outreach.openai",
        "secret-value",
        master,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      saveVaultKey(conn, a, "personal", "__proto__", "secret-value", master),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      saveVaultKey(conn, a, "personal", "outreach.openai", "short", master),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      saveVaultKey(
        conn,
        a,
        "personal",
        "outreach.openai",
        "x".repeat(4097),
        master,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      saveVaultKey(
        conn,
        a,
        "personal",
        "outreach.openai",
        "secret-value",
        undefined,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await saveVaultKey(
      conn,
      a,
      "personal",
      "outreach.openai",
      "secret-value",
      master,
    );
    expect(
      await resolveVaultKey(conn, a, "outreach.openai", {
        OPENAI_API_KEY: "env-secret",
      }),
    ).toBe("env-secret");
    await expect(
      removeVaultKey(conn, a, "personal", "outreach.openai", undefined),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolveVaultKey(conn, a, "outreach.openai", {
        ...env,
        ENCRYPTION_MASTER_KEY: "b".repeat(40),
      }),
    ).rejects.toThrow("Unable to decrypt");
    await removeVaultKey(
      conn,
      { ...a, workspaceId: "other" },
      "personal",
      "outreach.openai",
      master,
    );
    expect(await listVaultKeys(conn, a)).toHaveLength(1);
  });
});
