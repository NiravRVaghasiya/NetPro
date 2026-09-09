import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCard, executeCardViews } from "./card";
import { createProgram } from "../cli";
import { createTestSqliteConn } from "@netpro/db/src/testing";

const openDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("card must be offline");
  }),
);
vi.mock("../db", () => ({
  openDb,
  resolveCliScope: vi.fn(async () => undefined),
}));

let folder: string;
let input: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "netpro-card-"));
  input = join(folder, "profile.json");
  writeFileSync(
    input,
    JSON.stringify({ fullName: "Ada Lovelace", email: "ada@example.com" }),
  );
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("netpro card", () => {
  it("renders HTML to stdout by default, without opening a database", () => {
    const result = executeCard({ input, generate: true });
    expect(result.output).toBe(result.content);
    expect(result.content).toContain("<!doctype html>");
    expect(result.content).toContain("Ada Lovelace");
    expect(openDb).not.toHaveBeenCalled();
  });

  it("writes a vCard file and reports where it went", () => {
    const output = join(folder, "contact.vcf");
    const result = executeCard({ input, format: "vcard", output });
    expect(result.output).toContain(output);
    expect(readFileSync(output, "utf8")).toBe(result.content);
    expect(result.content).toContain("FN:Ada Lovelace\r\n");
  });

  it("writes standalone HTML", () => {
    const output = join(folder, "card.html");
    executeCard({ input, output });
    expect(readFileSync(output, "utf8")).toContain("Ada Lovelace");
  });

  it.each([
    [{}, /--input/],
    [{ input: "missing.json" }, /ENOENT/],
    [{ format: "pdf" }, /html or vcard/],
  ])("rejects invalid CLI options: %j", (options, error) => {
    expect(() =>
      executeCard({
        input,
        ...options,
        ...(Object.keys(options).length ? {} : { input: undefined }),
      }),
    ).toThrow(error);
  });

  it("rejects invalid JSON and unsafe profile fields", () => {
    writeFileSync(input, "not JSON");
    expect(() => executeCard({ input })).toThrow(/valid JSON/);
    writeFileSync(input, '{"fullName":"Ada","notes":"private"}');
    expect(() => executeCard({ input })).toThrow(/unsupported/);
  });

  it("rejects oversized input and never overwrites its source JSON", () => {
    expect(() => executeCard({ input, output: input })).toThrow(/different/);
    writeFileSync(input, "x".repeat(32769));
    expect(() => executeCard({ input })).toThrow(/32 KiB/);
  });

  it("embeds the view pixel only when --pixel-url is passed (v2.5 phase 2)", () => {
    const plain = executeCard({ input }).content;
    expect(plain).not.toContain("<img");

    const withPixel = executeCard({
      input,
      pixelUrl: "https://net.example/api/card/pixel.gif?p=blog",
    }).content;
    expect(withPixel).toContain(
      '<img src="https://net.example/api/card/pixel.gif?p=blog" width="1" height="1" alt=""',
    );
    // The offline CSP stays locked down, widened to exactly that origin.
    expect(withPixel).toContain("img-src https://net.example");
    expect(withPixel).toContain("default-src 'none'");
  });

  it.each([
    [
      {
        pixelUrl: "https://net.example/api/card/pixel.gif?p=blog",
        format: "vcard",
      },
      /HTML cards/,
    ],
    [{ pixelUrl: "not a url" }, /absolute http/],
    [{ pixelUrl: "javascript:alert(1)" }, /absolute http/],
  ])("rejects unsafe or misplaced pixel URLs: %j", (options, error) => {
    expect(() => executeCard({ input, ...options })).toThrow(error);
  });

  it("wires flags to real generation through Commander", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "netpro",
      "card",
      "--generate",
      "--input",
      input,
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("<!doctype html>"),
    );
    expect(openDb).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit status for invalid input without a stack trace", async () => {
    writeFileSync(input, "not JSON");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "netpro",
      "card",
      "--input",
      input,
    ]);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "netpro card: Profile must be valid JSON.",
    );
  });
});

describe("netpro card --views (v2.5 phase 3)", () => {
  function seedViews(): ReturnType<typeof createTestSqliteConn> {
    const f = createTestSqliteConn();
    f.conn.db
      .insert(f.conn.schema.contacts)
      .values({
        id: "ada",
        fullName: "Ada Lovelace",
        company: "Analytical Engines",
        source: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    const rows = [
      {
        id: "w1",
        daysAgo: 0,
        referrer: "https://blog.example/hello",
        country: "GB",
        contact: "ada",
      },
      { id: "w2", daysAgo: 1, referrer: null, country: null, contact: null },
    ];
    for (const [i, r] of rows.entries()) {
      f.conn.db
        .insert(f.conn.schema.profileViews)
        .values({
          id: r.id,
          viewerIp: `1${i}23456789abcdef`,
          viewerFingerprint: `e1${i}23456789abcde`,
          isBot: false,
          isOwnerView: false,
          sessionId: `sess-${r.id}`,
          viewedPage: "/card",
          viewedAt: new Date(Date.now() - r.daysAgo * 86_400_000).toISOString(),
          referrer: r.referrer,
          country: r.country,
          resolvedContact: r.contact,
        })
        .run();
    }
    return f;
  }

  it("renders the summary plus the recent timeline", async () => {
    const f = seedViews();
    try {
      const out = await executeCardViews({ views: true }, f.conn);
      expect(out).toMatch(/Profile views \(last 30 days\):/);
      expect(out).toMatch(/2 views · 2 unique viewers · 1 known-visitor view/);
      expect(out).toMatch(/blog\.example {2}1 \(50%\)/);
      expect(out).toMatch(/Recent views \(showing 2 of 2\):/);
      expect(out).toMatch(/Ada Lovelace/);
    } finally {
      f.sqlite.close();
    }
  });

  it("shows the empty state on a fresh database", async () => {
    const f = createTestSqliteConn();
    try {
      expect(await executeCardViews({ views: true }, f.conn)).toMatch(
        /No views yet/,
      );
    } finally {
      f.sqlite.close();
    }
  });

  it("--json emits the views overview object for scripts", async () => {
    const f = seedViews();
    try {
      const parsed = JSON.parse(
        await executeCardViews({ views: true, json: true }, f.conn),
      ) as {
        stats: { totals: { views: number; uniqueViewers: number } };
        recent: { total: number; views: unknown[] };
        matches: { total: number };
      };
      expect(parsed.stats.totals).toEqual({
        views: 2,
        uniqueViewers: 2,
        resolvedContacts: 1,
        avgDurationMs: null,
      });
      expect(parsed.recent.total).toBe(2);
      expect(parsed.recent.views).toHaveLength(2);
      expect(parsed.matches.total).toBe(1);
    } finally {
      f.sqlite.close();
    }
  });

  it("honors --days and --limit, and validates them", async () => {
    const f = seedViews();
    try {
      const out = await executeCardViews(
        { views: true, days: "7", limit: "1" },
        f.conn,
      );
      expect(out).toMatch(/Profile views \(last 7 days\):/);
      expect(out).toMatch(/Recent views \(showing 1 of 2\):/);
      await expect(
        executeCardViews({ views: true, days: "0" }, f.conn),
      ).rejects.toThrow(/positive integer/);
      await expect(
        executeCardViews({ views: true, days: "91" }, f.conn),
      ).rejects.toThrow(/days must be/);
      await expect(
        executeCardViews({ views: true, limit: "abc" }, f.conn),
      ).rejects.toThrow(/positive integer/);
    } finally {
      f.sqlite.close();
    }
  });

  it("refuses generation flags in views mode, and views flags in generate mode", async () => {
    const f = seedViews();
    try {
      await expect(
        executeCardViews({ views: true, input }, f.conn),
      ).rejects.toThrow(/not to --views/);
      await expect(
        executeCardViews({ views: true, format: "vcard" }, f.conn),
      ).rejects.toThrow(/not to --views/);
      await expect(
        executeCardViews(
          { views: true, pixelUrl: "https://x.example/p.gif" },
          f.conn,
        ),
      ).rejects.toThrow(/not to --views/);
    } finally {
      f.sqlite.close();
    }
    expect(() => executeCard({ input, days: "7" })).toThrow(
      /only applies with --views/,
    );
    expect(() => executeCard({ input, json: true })).toThrow(
      /only applies with --views/,
    );
    expect(() => executeCard({ input, views: true })).toThrow(/on its own/);
  });

  it("ignores the --generate marker in views mode instead of erroring", async () => {
    const f = createTestSqliteConn();
    try {
      expect(
        await executeCardViews({ views: true, generate: true }, f.conn),
      ).toMatch(/Profile views/);
    } finally {
      f.sqlite.close();
    }
  });

  it("opens the database only in views mode (Commander wiring)", async () => {
    const f = createTestSqliteConn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(openDb).mockResolvedValueOnce(f.conn as never);
    try {
      await createProgram().parseAsync(["node", "netpro", "card", "--views"]);
      expect(openDb).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Profile views"),
      );
    } finally {
      f.sqlite.close();
    }
  });
});
