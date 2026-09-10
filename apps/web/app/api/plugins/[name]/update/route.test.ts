import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireMembership } = vi.hoisted(() => ({ mockRequireMembership: vi.fn() }));
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({ requireMembership: mockRequireMembership }));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEntry, fixtureIndex, fixtureTarGz, sha256Hex } from "@netpro/core/src/plugins/testing";
import { installPluginFromMarketplace } from "@netpro/core/src/plugins/marketplace";
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

function tarballEntry(dir: string, name: string, version: string, marker: string) {
  const tgz = fixtureTarGz({ name, version, extraFiles: [{ path: "marker.txt", data: marker }] });
  const file = join(dir, `${name}-${version}.tgz`);
  writeFileSync(file, tgz);
  return fixtureEntry({ name, version, url: pathToFileURL(file).href, sha256: sha256Hex(tgz) });
}

function writeIndexFile(dir: string, entries: Array<ReturnType<typeof tarballEntry>>): string {
  const file = join(dir, "index.json");
  writeFileSync(file, JSON.stringify(fixtureIndex(entries)), "utf8");
  return file;
}

const postUpdate = (name: string, body: unknown) =>
  POST(
    new Request(`http://localhost/api/plugins/${name}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) }
  );

describe("POST /api/plugins/[name]/update (Phase 6)", () => {
  it("applies newer versions and no-ops on identical ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "netpro-web-update-"));
    const name = `web-update-${process.pid}`;
    try {
      const v1 = tarballEntry(dir, name, "1.0.0", "v1");
      const pluginDir = join(dir, "plugins");
      await installPluginFromMarketplace(fixture.conn, name, { index: fixtureIndex([v1]), pluginDir, scope: adminScope });
      const v2 = tarballEntry(dir, name, "1.1.0", "v2");
      process.env.MARKETPLACE_INDEX_URL = pathToFileURL(writeIndexFile(dir, [v2])).href;
      process.env.NETPRO_PLUGIN_DIR = pluginDir;

      const res = await postUpdate(name, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: boolean; plugin: { version: string } };
      expect(body.updated).toBe(true);
      expect(body.plugin.version).toBe("1.1.0");
      expect(readFileSync(join(pluginDir, name, "marker.txt"), "utf8")).toBe("v2");

      const noop = (await (await postUpdate(name, {})).json()) as { updated: boolean };
      expect(noop.updated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses downgrades unless forced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "netpro-web-update-"));
    const name = `web-downgrade-${process.pid}`;
    try {
      const v2 = tarballEntry(dir, name, "2.0.0", "v2");
      const pluginDir = join(dir, "plugins");
      await installPluginFromMarketplace(fixture.conn, name, { index: fixtureIndex([v2]), pluginDir, scope: adminScope });
      const v1 = tarballEntry(dir, name, "1.0.0", "v1");
      process.env.MARKETPLACE_INDEX_URL = pathToFileURL(writeIndexFile(dir, [v1])).href;
      process.env.NETPRO_PLUGIN_DIR = pluginDir;

      expect((await postUpdate(name, {})).status).toBe(409);
      const forced = await postUpdate(name, { force: true });
      expect(forced.status).toBe(200);
      expect(((await forced.json()) as { plugin: { version: string } }).plugin.version).toBe("1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404s for plugins that are not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "netpro-web-update-"));
    try {
      const entry = tarballEntry(dir, "ghost", "1.0.0", "x");
      process.env.MARKETPLACE_INDEX_URL = pathToFileURL(writeIndexFile(dir, [entry])).href;
      process.env.NETPRO_PLUGIN_DIR = join(dir, "plugins");
      expect((await postUpdate("ghost", {})).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the admin floor", async () => {
    mockRequireMembership.mockRejectedValue(Object.assign(new Error("Forbidden: requires admin role"), { status: 403 }));
    expect((await postUpdate("x", {})).status).toBe(403);
  });
});
