import { describe, it, expect, beforeEach } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { SqliteConn } from "@netpro/db";
import {
  executeReindex,
  formatStatus,
  formatSummary,
  parseLimit,
  readEmbeddingsConfig,
} from "./reindex";
import type { EmbeddingProvider } from "@netpro/core/src/search";

let conn: SqliteConn;
let sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

function insertContact(id: string, fullName: string, company?: string): void {
  sqlite
    .prepare(
      `INSERT INTO contacts (id, workspace_id, full_name, company, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "default",
      fullName,
      company ?? null,
      "manual",
      "2026-01-01",
      "2026-01-01",
    );
}

/** Keychain double — the real one reads an encrypted file in $HOME. */
function fakeKeychain(store: Record<string, string> = {}) {
  return { get: async (key: string) => store[key] ?? null };
}

beforeEach(() => {
  const created = createTestSqliteConn();
  conn = created.conn;
  sqlite = created.sqlite;
});

describe("parseLimit", () => {
  it("accepts a positive integer and passes undefined through", () => {
    expect(parseLimit("25")).toBe(25);
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "abc", ""])("rejects %j", (value) => {
    expect(() => parseLimit(value)).toThrow(/positive integer/);
  });
});

describe("readEmbeddingsConfig", () => {
  it("is disabled with an empty keychain and empty environment", async () => {
    const config = await readEmbeddingsConfig({}, fakeKeychain());
    expect(config).toEqual({ provider: "disabled" });
  });

  it("treats a keychain key alone as enabling openai", async () => {
    const config = await readEmbeddingsConfig(
      {},
      fakeKeychain({ "embeddings.key": "sk-keychain" }),
    );
    expect(config).toMatchObject({ provider: "openai", apiKey: "sk-keychain" });
  });

  it("lets the environment override the keychain", async () => {
    const config = await readEmbeddingsConfig(
      { EMBEDDINGS_API_KEY: "sk-env", EMBEDDINGS_MODEL: "env-model" },
      fakeKeychain({
        "embeddings.key": "sk-keychain",
        "embeddings.model": "kc-model",
      }),
    );
    expect(config.apiKey).toBe("sk-env");
    expect(config.model).toBe("env-model");
  });

  it("honours an explicit disable in the environment over a stored key", async () => {
    const config = await readEmbeddingsConfig(
      { EMBEDDINGS_PROVIDER: "disabled" },
      fakeKeychain({ "embeddings.key": "sk-keychain" }),
    );
    expect(config.provider).toBe("disabled");
  });

  it("reads the model and base url from the keychain", async () => {
    const config = await readEmbeddingsConfig(
      {},
      fakeKeychain({
        "embeddings.key": "sk-keychain",
        "embeddings.model": "text-embedding-3-large",
        "embeddings.baseUrl": "https://gw.example/v1",
      }),
    );
    expect(config).toMatchObject({
      model: "text-embedding-3-large",
      baseUrl: "https://gw.example/v1",
    });
  });
});

describe("executeReindex", () => {
  it("indexes every contact and reports what it did", async () => {
    insertContact("c1", "Jane Doe", "Stripe");
    insertContact("c2", "John Smith", "Vercel");

    const { output, failed } = await executeReindex({}, conn);
    expect(failed).toBe(false);
    expect(output).toContain(
      "Scanned 2 contacts: 2 indexed, 0 unchanged, 0 pruned.",
    );
    expect(output).not.toContain("Embeddings");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 2 });
  });

  it("is idempotent on a second run", async () => {
    insertContact("c1", "Jane Doe");
    await executeReindex({}, conn);
    const { output } = await executeReindex({}, conn);
    expect(output).toContain("0 indexed, 1 unchanged");
  });

  it("--force rewrites unchanged rows", async () => {
    insertContact("c1", "Jane Doe");
    await executeReindex({}, conn);
    const { output } = await executeReindex({ force: true }, conn);
    expect(output).toContain("1 indexed, 0 unchanged");
  });

  it("--contact scopes the run", async () => {
    insertContact("c1", "Jane Doe");
    insertContact("c2", "John Smith");
    const { output } = await executeReindex({ contact: ["c1"] }, conn);
    expect(output).toContain("Scanned 1 contact:");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 1 });
  });

  it("--limit caps the run", async () => {
    insertContact("c1", "A");
    insertContact("c2", "B");
    insertContact("c3", "C");
    expect((await executeReindex({ limit: "2" }, conn)).output).toContain(
      "Scanned 2 contacts",
    );
  });

  it("rejects a bad --limit before touching the database", async () => {
    await expect(executeReindex({ limit: "-3" }, conn)).rejects.toThrow(
      /positive integer/,
    );
  });

  it("--json prints the raw summary", async () => {
    insertContact("c1", "Jane Doe");
    const { output } = await executeReindex({ json: true }, conn);
    expect(JSON.parse(output)).toMatchObject({
      scanned: 1,
      indexed: 1,
      skipped: 0,
      pruned: 0,
      embedded: 0,
      embeddingError: null,
    });
  });

  it("--status reports coverage without writing anything", async () => {
    insertContact("c1", "Jane Doe");
    const { output } = await executeReindex({ status: true }, conn);
    expect(output).toContain("Full-text index: available");
    expect(output).toContain("Contacts:        1");
    expect(output).toContain("not indexed — run netpro reindex");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 0 });
  });

  it("--status --json returns the structured status", async () => {
    insertContact("c1", "Jane Doe");
    const { output } = await executeReindex({ status: true, json: true }, conn);
    expect(JSON.parse(output)).toMatchObject({
      contacts: 1,
      indexed: 0,
      embedded: 0,
      keywordIndexAvailable: true,
    });
  });

  it("--embeddings without a key fails with an actionable message", async () => {
    insertContact("c1", "Jane Doe");
    await expect(
      executeReindex({ embeddings: true }, conn, {
        config: { provider: "disabled" },
      }),
    ).rejects.toThrow(/netpro config set embeddings\.key/);
    // And it must not have written a half-finished index.
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 0 });
  });
});

describe("formatting", () => {
  it("warns when vectors from two models are stored", () => {
    const output = formatStatus({
      contacts: 10,
      indexed: 10,
      embedded: 10,
      embeddingModels: ["model-a", "model-b"],
      keywordIndexAvailable: true,
    });
    expect(output).toContain("more than one model");
    expect(output).toContain("netpro reindex --embeddings --force");
  });

  it("tells the user to migrate when the full-text index is missing", () => {
    const output = formatStatus({
      contacts: 3,
      indexed: 0,
      embedded: 0,
      embeddingModels: [],
      keywordIndexAvailable: false,
    });
    expect(output).toContain("MISSING (run netpro migrate)");
  });

  it("says semantic search is off when nothing is embedded", () => {
    const output = formatStatus({
      contacts: 3,
      indexed: 3,
      embedded: 0,
      embeddingModels: [],
      keywordIndexAvailable: true,
    });
    expect(output).toContain("semantic search off");
  });

  it("reports a partial embedding failure without hiding what landed", () => {
    const embedder: EmbeddingProvider = {
      id: "openai",
      model: "m",
      embed: async () => [],
    };
    const output = formatSummary(
      {
        scanned: 5,
        indexed: 5,
        skipped: 0,
        pruned: 0,
        embedded: 2,
        embeddingError: "Embeddings request failed: 429 quota exceeded",
      },
      embedder,
    );
    expect(output).toContain("5 indexed");
    expect(output).toContain("2 written");
    expect(output).toContain("quota exceeded");
    expect(output).toContain("keyword index was still updated");
  });
});

describe("executeReindex — embeddings path", () => {
  const embedder: EmbeddingProvider = {
    id: "openai",
    model: "fake-model",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };

  it("exits non-zero when embeddings fail but keeps the keyword index", async () => {
    insertContact("c1", "Jane Doe", "Stripe");
    // Route through the real code path by handing executeReindex a config that
    // builds a provider whose fetch always fails.
    const failing = await executeReindex({ embeddings: true }, conn, {
      config: {
        provider: "openai",
        apiKey: "sk-test",
        model: "fake-model",
        baseUrl: "https://embeddings.invalid/v1",
      },
    }).catch((e: unknown) => e);

    // The provider itself is constructed fine; the network call inside fails,
    // which reindex reports rather than throws.
    expect(failing).not.toBeInstanceOf(Error);
    const { output, failed } = failing as { output: string; failed: boolean };
    expect(failed).toBe(true);
    expect(output).toContain("1 indexed");
    expect(output).toContain("Embeddings failed");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM search_index").get(),
    ).toEqual({ n: 1 });
  }, 20_000);

  it("stores vectors when the provider works", async () => {
    insertContact("c1", "Jane Doe", "Stripe");
    // Bypass credential resolution by exercising the core directly through the
    // same summary formatter the command prints.
    const { reindexSearchIndex } = await import("@netpro/core/src/search");
    const summary = await reindexSearchIndex(conn, { embedder });
    expect(formatSummary(summary, embedder)).toContain(
      "Embeddings (fake-model): 1 written.",
    );
  });
});
