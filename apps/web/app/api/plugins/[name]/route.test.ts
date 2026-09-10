import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireMembership } = vi.hoisted(() => ({ mockRequireMembership: vi.fn() }));
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({ requireMembership: mockRequireMembership }));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, getPluginByName } from "@netpro/core/src/plugins/repository";
import { GET, DELETE } from "./route";

const adminScope = { userId: "tester", workspaceId: "default", role: "admin" } as const;
let savedPluginDir: string | undefined;

beforeEach(() => {
  fixture.sqlite.exec("DELETE FROM plugins; DELETE FROM activity_log;");
  mockRequireMembership.mockReset();
  mockRequireMembership.mockResolvedValue(adminScope);
  savedPluginDir = process.env.NETPRO_PLUGIN_DIR;
});

afterEach(() => {
  if (savedPluginDir === undefined) delete process.env.NETPRO_PLUGIN_DIR;
  else process.env.NETPRO_PLUGIN_DIR = savedPluginDir;
});

afterAll(() => fixture.sqlite.close());

const manifest = {
  name: "web-rm-plugin",
  version: "1.0.0",
  engine: "^3.0.0",
  permissions: { capabilities: ["command"] as Array<"command"> },
};

describe("GET /api/plugins/[name]", () => {
  it("returns the plugin or 404s", async () => {
    await createPlugin(fixture.conn, { name: manifest.name, version: manifest.version, manifest }, adminScope);
    const res = await GET(new Request("http://localhost/api/plugins/web-rm-plugin"), {
      params: Promise.resolve({ name: "web-rm-plugin" }),
    });
    expect(res.status).toBe(200);
    const missing = await GET(new Request("http://localhost/api/plugins/ghost"), {
      params: Promise.resolve({ name: "ghost" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /api/plugins/[name] (Phase 6)", () => {
  it("unregisters and deletes the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "netpro-web-rm-"));
    try {
      process.env.NETPRO_PLUGIN_DIR = join(dir, "plugins");
      mkdirSync(join(dir, "plugins", manifest.name), { recursive: true });
      writeFileSync(join(dir, "plugins", manifest.name, "index.js"), "x", "utf8");
      await createPlugin(fixture.conn, { name: manifest.name, version: manifest.version, manifest }, adminScope);

      const res = await DELETE(new Request("http://localhost/api/plugins/web-rm-plugin", { method: "DELETE" }), {
        params: Promise.resolve({ name: manifest.name }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { filesRemoved: boolean }).filesRemoved).toBe(true);
      expect(await getPluginByName(fixture.conn, manifest.name, adminScope)).toBeNull();
      expect(existsSync(join(dir, "plugins", manifest.name))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404s for plugins that are not installed", async () => {
    const res = await DELETE(new Request("http://localhost/api/plugins/ghost", { method: "DELETE" }), {
      params: Promise.resolve({ name: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("enforces the admin floor", async () => {
    mockRequireMembership.mockRejectedValue(Object.assign(new Error("Forbidden: requires admin role"), { status: 403 }));
    const res = await DELETE(new Request("http://localhost/api/plugins/x", { method: "DELETE" }), {
      params: Promise.resolve({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});
