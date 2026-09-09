import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
const membership = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/authz", () => ({ requireMembership: membership }));
import { GET, POST, DELETE } from "./route";
import { providerEnvironment, providerStatusEnvironment } from "@/lib/vault";

const scope = { workspaceId: "default", userId: "alice", role: "admin" };
const secret = "sk-do-not-expose-this-key";
function request(body: unknown) {
  return new Request("http://localhost/api/settings/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_MASTER_KEY", "a".repeat(40));
  membership.mockReset();
  membership.mockResolvedValue(scope);
  fixture.sqlite.exec(
    `DELETE FROM key_vault; INSERT OR IGNORE INTO "user" (id,email) VALUES ('alice','alice@example.test'), ('bob','bob@example.test');`,
  );
});
afterAll(() => {
  fixture.sqlite.close();
  vi.unstubAllEnvs();
});

describe("credential API boundary", () => {
  it("returns 401/403 without reading or mutating secrets", async () => {
    for (const status of [401, 403]) {
      membership.mockRejectedValue(
        Object.assign(new Error("denied"), { status }),
      );
      expect((await GET()).status).toBe(status);
      expect((await POST(request({}))).status).toBe(status);
      expect((await DELETE(request({}))).status).toBe(status);
    }
  });
  it("ignores forged principals, uses scoped provider credentials, and returns metadata only", async () => {
    const response = await POST(
      request({
        target: "personal",
        keyName: "outreach.openai",
        secret,
        workspaceId: "evil",
        userId: "bob",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
    const status = await providerStatusEnvironment(["outreach.openai"]);
    expect(status.OPENAI_API_KEY).toBe("configured-in-vault");
    expect((await (await GET()).json()).keys[0].lastUsedAt).toBeNull();
    expect(
      (await providerEnvironment(["outreach.openai"])).OPENAI_API_KEY,
    ).toBe(secret);
    const result = await GET();
    expect(result.headers.get("cache-control")).toContain("no-store");
    const json = await result.json();
    expect(json.keys[0].userId).toBe("alice");
    expect(json.keys[0].lastUsedAt).toBeTruthy();
    expect(JSON.stringify(json)).not.toContain(secret);
    expect(JSON.stringify(json)).not.toContain("ciphertext");
    membership.mockResolvedValue({ ...scope, userId: "bob" });
    expect((await (await GET()).json()).keys).toHaveLength(0);
  });
  it("enforces shared-key admin floor in core even when the boundary is permissive", async () => {
    membership.mockResolvedValue({ ...scope, role: "member" });
    expect(
      (
        await POST(
          request({ target: "workspace", keyName: "outreach.openai", secret }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await DELETE(
          request({ target: "workspace", keyName: "outreach.openai" }),
        )
      ).status,
    ).toBe(403);
    membership.mockResolvedValue({ ...scope, role: "viewer" });
    expect(
      (
        await POST(
          request({ target: "personal", keyName: "outreach.openai", secret }),
        )
      ).status,
    ).toBe(403);
  });
  it("bounds input and refuses missing-master writes while metadata remains readable", async () => {
    expect(
      (
        await POST(
          request({
            target: "personal",
            keyName: "outreach.openai",
            secret: "x".repeat(17000),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await POST(
          request({ target: "bogus", keyName: "outreach.openai", secret }),
        )
      ).status,
    ).toBe(400);
    vi.stubEnv("ENCRYPTION_MASTER_KEY", "");
    expect(
      (
        await POST(
          request({ target: "personal", keyName: "outreach.openai", secret }),
        )
      ).status,
    ).toBe(503);
    expect((await (await GET()).json()).writable).toBe(false);
  });
});
