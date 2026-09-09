import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import {
  createEmbeddingProvider,
  resolveEmbeddingsConfig,
  reindexSearchIndex,
  searchIndexStatus,
  EmbeddingsError,
  type EmbeddingProvider,
  type EmbeddingsConfig,
  type ReindexSummary,
  type SearchIndexStatus,
} from "@netpro/core/src/search";
import { Keychain } from "../config/keychain";

export interface ReindexCommandOptions {
  embeddings?: boolean;
  force?: boolean;
  limit?: string;
  contact?: string[];
  status?: boolean;
  json?: boolean;
}

/**
 * Resolve embeddings credentials the same way `netpro outreach` resolves AI
 * credentials: encrypted keychain first-class, environment as the override.
 * Exported so tests can exercise the precedence without touching disk.
 */
export async function readEmbeddingsConfig(
  env: NodeJS.ProcessEnv = process.env,
  keychain: {
    get(key: string): Promise<string | null>;
  } = Keychain,
): Promise<EmbeddingsConfig> {
  const [provider, key, model, baseUrl] = await Promise.all([
    keychain.get("embeddings.provider"),
    keychain.get("embeddings.key"),
    keychain.get("embeddings.model"),
    keychain.get("embeddings.baseUrl"),
  ]);

  // A key in the keychain is enough to mean "enabled" — requiring the user to
  // also set a provider name would be a pointless second step, since openai is
  // the only implementation.
  const merged: NodeJS.ProcessEnv = {
    ...env,
    EMBEDDINGS_PROVIDER:
      env.EMBEDDINGS_PROVIDER ?? provider ?? (key ? "openai" : undefined),
    EMBEDDINGS_API_KEY: env.EMBEDDINGS_API_KEY ?? key ?? undefined,
    EMBEDDINGS_MODEL: env.EMBEDDINGS_MODEL ?? model ?? undefined,
    EMBEDDINGS_BASE_URL: env.EMBEDDINGS_BASE_URL ?? baseUrl ?? undefined,
  };
  return resolveEmbeddingsConfig(merged as Record<string, string | undefined>);
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer, got "${value}"`);
  }
  return n;
}

export function formatStatus(status: SearchIndexStatus): string {
  const lines: string[] = [];
  const missing = Math.max(status.contacts - status.indexed, 0);
  lines.push(
    `Full-text index: ${status.keywordIndexAvailable ? "available" : "MISSING (run netpro migrate)"}`,
  );
  lines.push(`Contacts:        ${status.contacts}`);
  lines.push(
    `Indexed:         ${status.indexed}${missing > 0 ? `  (${missing} not indexed — run netpro reindex)` : ""}`,
  );
  lines.push(
    `Embedded:        ${status.embedded}${
      status.embedded === 0 ? "  (semantic search off)" : ""
    }`,
  );
  if (status.embeddingModels.length > 0) {
    lines.push(`Embedding model: ${status.embeddingModels.join(", ")}`);
  }
  if (status.embeddingModels.length > 1) {
    lines.push(
      "Warning: vectors from more than one model are stored. They are not " +
        "comparable — run `netpro reindex --embeddings --force`.",
    );
  }
  return lines.join("\n");
}

export function formatSummary(
  summary: ReindexSummary,
  embedder: EmbeddingProvider | null,
): string {
  const lines = [
    `Scanned ${summary.scanned} contact${summary.scanned === 1 ? "" : "s"}: ` +
      `${summary.indexed} indexed, ${summary.skipped} unchanged, ${summary.pruned} pruned.`,
  ];
  if (embedder) {
    lines.push(`Embeddings (${embedder.model}): ${summary.embedded} written.`);
  }
  if (summary.embeddingError) {
    lines.push(
      `Embeddings failed: ${summary.embeddingError}\n` +
        "The keyword index was still updated — search stays available, " +
        "semantic ranking is off until you re-run.",
    );
  }
  return lines.join("\n");
}

export async function executeReindex(
  options: ReindexCommandOptions,
  conn: SqliteConn | PgConn,
  deps: { config?: EmbeddingsConfig } = {},
  scope?: WorkspaceScope,
): Promise<{ output: string; failed: boolean }> {
  if (options.status) {
    const status = await searchIndexStatus(conn, scope);
    return {
      output: options.json
        ? JSON.stringify(status, null, 2)
        : formatStatus(status),
      failed: false,
    };
  }

  const limit = parseLimit(options.limit);

  let embedder: EmbeddingProvider | null = null;
  if (options.embeddings) {
    const config = deps.config ?? (await readEmbeddingsConfig());
    embedder = createEmbeddingProvider(config);
    if (!embedder) {
      throw new EmbeddingsError(
        "not_configured",
        "No embeddings key configured. Set one with " +
          '"netpro config set embeddings.key sk-..." or EMBEDDINGS_API_KEY in the ' +
          "environment. (Keyword search needs no key — just run `netpro reindex`.)",
      );
    }
  }

  const summary = await reindexSearchIndex(
    conn,
    {
      embedder,
      force: options.force,
      limit,
      contactIds: options.contact,
    },
    scope,
  );

  return {
    output: options.json
      ? JSON.stringify(summary, null, 2)
      : formatSummary(summary, embedder),
    // A partial embedding failure is reported as a non-zero exit so a cron or
    // deploy script can tell, while the printed summary still shows what
    // landed.
    failed: summary.embeddingError !== null,
  };
}

export function registerReindexCommand(program: Command): void {
  const cmd = program
    .command("reindex")
    .description(
      "Rebuild the full-text search index (and optionally embeddings) for hybrid search",
    )
    .option(
      "--embeddings",
      "Also compute embeddings (requires a configured key)",
    )
    .option("--force", "Rewrite every row, even unchanged ones")
    .option("--limit <n>", "Process at most N contacts")
    .option("--contact <id...>", "Only reindex these contact ids (repeatable)")
    .option("--status", "Show index coverage instead of rebuilding")
    .option("--json", "Print raw JSON instead of a summary")
    .action(async (opts: ReindexCommandOptions) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const { output, failed } = await executeReindex(opts, conn, {}, scope);
        console.log(output);
        if (failed) process.exitCode = 1;
      } catch (e) {
        console.error(`netpro reindex: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
