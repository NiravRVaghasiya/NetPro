import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireMembership } = vi.hoisted(() => ({ mockRequireMembership: vi.fn() }));
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({ requireMembership: mockRequireMembership }));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEntry, fixtureIndex, fixtureTarGz, sha256Hex } from "@netpro/core/src/plugins/testing";
import { getPluginByName } from "@netpro/core/src/plugins/repository";
import { POST } from "./route";

const adminScope = { userId: "tester", workspaceId: "default", role: "admin" } as const;
const ENV_KEYS = ["MARKETPLACE_INDEX_URL", "MARKETPLACE_CACHE_PATH", "MARKETPLACE_NO_CACHE", "NETPRO_PLUGIN_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture.sqlite.exec("DELETE FROM plugins; DELETE FROM activity_log;");
  mockRequireMembership.mockReset();
  mockRequireMembership.mockResolvedValue(adminScope);
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MARKETPLACE_CACHE_PATH = join(mkdtempSync(join(tmpdir(), "netpro-web-cache-")), "cache.json");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => fixture.sqlite.close());

function setupMarketplace(name: string): { dir: string; pluginDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "netpro-web-install-"));
  const tgz = fixtureTarGz({ name, network: ["api.install.invalid"] });
  const tarballFile = join(dir, "plugin.tgz");
  writeFileSync(tarballFile, tgz);
  const entry = fixtureEntry({
    name,
    url: pathToFileURL(tarballFile).href,
    sha256: sha256Hex(tgz),
    network: ["api.install.invalid"],
  });
  const indexFile = join(dir, "index.json");
  writeFileSync(indexFile, JSON.stringify(fixtureIndex([entry])), "utf8");
  process.env.MARKETPLACE_INDEX_URL = pathToFileURL(indexFile).href;
  const pluginDir = join(dir, "plugins");
  process.env.NETPRO_PLUGIN_DIR = pluginDir;
  return { dir, pluginDir };
}

const postJson = (body: unknown) =>
  POST(
    new Request("http://localhost/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

describe("POST /api/plugins/install (Phase 6)", () => {
  it("installs disabled and returns the permissions review", async () => {
    const name = `web-install-${process.pid}`;
    const { dir, pluginDir } = setupMarketplace(name);
    try {
      const res = await postJson({ name });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        plugin: { name: string; enabled: boolean };
        review: { capabilities: string[]; network: string[]; engine: string };
      };
      expect(body.plugin.name).toBe(name);
      expect(body.plugin.enabled).toBe(false);
      expect(body.review.capabilities).toEqual(["command"]);
      expect(body.review.network).toEqual(["api.install.invalid"]);
      expect(existsSync(join(pluginDir, name, "manifest.json"))).toBe(true);
      expect(await getPluginByName(fixture.conn, name, adminScope)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps unknown plugins to 404 and double installs to 409", async () => {
    const name = `web-install-dup-${process.pid}`;
    const { dir } = setupMarketplace(name);
    try {
      expect((await postJson({ name: "ghost" })).status).toBe(404);
      expect((await postJson({ name })).status).toBe(201);
      const dup = await postJson({ name });
      expect(dup.status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the body", async () => {
    const { dir } = setupMarketplace(`web-install-body-${process.pid}`);
    try {
      expect((await postJson({})).status).toBe(400);
      expect((await postJson({ name: 42 })).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the admin floor", async () => {
    mockRequireMembership.mockRejectedValue(Object.assign(new Error("Forbidden: requires admin role"), { status: 403 }));
    expect((await postJson({ name: "x" })).status).toBe(403);
  });
});
