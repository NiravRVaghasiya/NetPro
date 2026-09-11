import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import type { ScanResult } from "@netpro/core/src/scan";
import type { Job, NetProEvent } from "@netpro/server";
import { resolveServerBaseUrl, runCliJob, serverReachable } from "../lib/jobs";

export interface ScanCommandOptions {
  /** Source label recorded on the job (default `linkedin_csv`). */
  source?: string;
  /** Print the raw job + result JSON instead of a progress narrative. */
  json?: boolean;
  /** `--no-enrich` sets this false: skip enrichment even with keys present. */
  enrich?: boolean;
  /** Never delegate to a running server — run the sweep in this process. */
  local?: boolean;
  /** Server to delegate to (default: NETPRO_SERVER_URL or 127.0.0.1:3777). */
  server?: string;
}

export type ScanDeps = {
  /** Already-open database (tests / callers that already have one). */
  conn?: SqliteConn | PgConn;
  scope?: WorkspaceScope;
  env?: NodeJS.ProcessEnv;
  keychain?: Record<string, string | null | undefined>;
  /** Server base URL override (tests). */
  serverUrl?: string;
  /** Reachability probe (tests). */
  probe?: (url: string) => Promise<boolean>;
  /** HTTP client (tests). */
  fetchImpl?: typeof fetch;
  /** Force the in-process path even when a server is running (tests). */
  local?: boolean;
};

export type ScanExecution = {
  /** `server` — the running NetPro server did the work; `local` — this process did. */
  mode: "server" | "local";
  /** The server's job when delegated; the CLI's job otherwise. */
  job: Job | null;
  result: ScanResult | null;
  serverUrl: string | null;
  /** Progress/stream events observed, oldest first. */
  events: NetProEvent[];
};

/** How long to keep the delegated stream open waiting for completion. */
const STREAM_TIMEOUT_MS = 10_000;

/**
 * Read an SSE response body and hand each parsed event to `onEvent`.
 *
 * The server's EventBus replays buffered history on connect, so a scan that
 * finished microseconds before this stream opened still prints its whole
 * ladder — the terminal experience is the same whether the terminal is fast
 * or the scan is slow.
 */
async function readEventStream(
  url: string,
  options: {
    fetchImpl: typeof fetch;
    onEvent: (event: NetProEvent) => void;
    timeoutMs?: number;
  }
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? STREAM_TIMEOUT_MS);
  try {
    const res = await options.fetchImpl(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === ": ping") continue;
            try {
              options.onEvent(JSON.parse(payload) as NetProEvent);
            } catch {
              // A partial or non-JSON frame is skipped, not fatal.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Abort (timeout) or a closed socket — the caller already has whatever
      // arrived.
    }
  } catch {
    // The stream is a nicety; the scan result is the contract.
  } finally {
    clearTimeout(timeout);
  }
}

function isTerminal(event: NetProEvent): boolean {
  return (
    event.type === "scan.completed" ||
    event.type === "job.completed" ||
    event.type === "job.failed" ||
    event.type === "scan.failed"
  );
}

/**
 * Delegate the scan to a running NetPro server.
 *
 * This is the strongest form of "one job system": the terminal does not run a
 * private scan, it asks the same server the Web UI talks to for the same job,
 * then watches that job's events on the same SSE stream the UI watches.
 */
async function scanOnServer(
  base: string,
  options: ScanCommandOptions,
  deps: ScanDeps
): Promise<ScanExecution | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const source = options.source?.trim() || "linkedin_csv";

  const res = await fetchImpl(`${base}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, origin: "cli", enrich: options.enrich ?? true }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { job?: Job; result?: ScanResult };
  if (!body.job) return null;

  const events: NetProEvent[] = [];
  const jobId = body.job.id;
  await readEventStream(`${base}/api/events/stream?jobId=${encodeURIComponent(jobId)}&history=50`, {
    fetchImpl,
    timeoutMs: STREAM_TIMEOUT_MS,
    onEvent: (event) => {
      events.push(event);
    },
  });
  // Stop as soon as the scan reaches a terminal event — the stream is a live
  // feed and would otherwise sit open.
  const terminalIndex = events.findIndex(isTerminal);
  return {
    mode: "server",
    job: body.job,
    result: body.result ?? null,
    serverUrl: base,
    events: terminalIndex >= 0 ? events.slice(0, terminalIndex + 1) : events,
  };
}

/** Run the sweep in this process, wrapped in the shared job + event model. */
async function scanLocally(
  options: ScanCommandOptions,
  deps: ScanDeps
): Promise<ScanExecution> {
  const conn = deps.conn ?? (await (await import("../db")).openDb());
  const { runScan } = await import("@netpro/core/src/scan");
  const source = options.source?.trim() || "linkedin_csv";

  const execution = await runCliJob<ScanResult>({
    type: "scan",
    metadata: { source, origin: "cli" },
    run: async (emit) => {
      emit.publish({ type: "scan.started", progress: 0, message: "Scan started", source });
      const result = await runScan(conn, {
        source,
        scope: deps.scope,
        enrich: options.enrich ?? true,
        env: (deps.env ?? process.env) as Record<string, string | undefined>,
        keychain: deps.keychain,
        onProgress: (update) => {
          emit.update(update.progress, update.message, { stage: update.stage });
          emit.publish({
            type: "scan.progress",
            progress: update.progress,
            message: update.message,
            stage: update.stage,
            source,
          });
        },
      });
      emit.publish({
        type: "scan.completed",
        progress: 100,
        message: "Scan complete",
        result,
        source,
      });
      return result;
    },
  });

  return {
    mode: "local",
    job: execution.job,
    result: execution.result,
    serverUrl: deps.serverUrl ?? null,
    events: execution.events,
  };
}

/**
 * `netpro scan` — one observable sweep (reindex + enrichment + graph).
 *
 * Phase 16: when a NetPro server is running, the terminal delegates to it, so
 * the scan is *the same server job* the Web UI renders (and the UI shows it
 * live). When no server is running, the CLI runs the identical core sweep
 * (`runScan`) in-process, wrapped in the same job model, and mirrors its
 * events to the server if one appears. Either way:
 *
 *   One core implementation · one job system · one event stream · two clients.
 */
export async function executeScan(
  options: ScanCommandOptions = {},
  deps: ScanDeps = {}
): Promise<ScanExecution> {
  const env = deps.env ?? process.env;
  const base = deps.serverUrl ?? (options.server?.trim() || resolveServerBaseUrl(env));
  const wantServer = !(options.local ?? deps.local ?? false);
  const probe = deps.probe ?? serverReachable;

  if (wantServer && (await probe(base))) {
    try {
      const delegated = await scanOnServer(base, options, deps);
      if (delegated) return delegated;
    } catch {
      // A server that answered the health probe but cannot run a scan falls
      // back to the in-process sweep rather than failing the command.
    }
  }

  return scanLocally(options, { ...deps, serverUrl: base });
}

/** Render the plan's terminal narrative: "Scan started" → 23% → … → summary. */
export function formatScan(execution: ScanExecution): string {
  const lines: string[] = [];
  const result = execution.result;

  if (execution.mode === "server") {
    lines.push(
      `Scan started on the NetPro server (${execution.serverUrl}) — job ${
        execution.job?.id.slice(0, 8) ?? "unknown"
      }`
    );
    lines.push("The Web UI is watching this same job: " + `${execution.serverUrl}`);
  } else {
    lines.push("Scan started");
  }

  // The ladder is the scan's own events; `job.*` events carry the same numbers
  // for the Web UI and would only double every line here. If a run somehow
  // produced no scan events (an older server, say) fall back to the job's.
  const ladder = execution.events.filter((e) => e.type.startsWith("scan."));
  const progress = ladder.length > 0 ? ladder : execution.events;
  let lastLine = "";
  for (const event of progress) {
    // The header above already says "started" — 0% adds nothing.
    if (typeof event.progress !== "number" || event.progress === 0) continue;
    const message = typeof event.message === "string" ? ` ${event.message}` : "";
    const line = `  ${String(event.progress).padStart(3)}%${message}`;
    // Core's last stage and the CLI's completion event are both "100% Scan
    // complete" — print the ladder, not every duplicate of its last rung.
    if (line === lastLine) continue;
    lastLine = line;
    lines.push(line);
    if (event.type === "scan.completed") break;
  }

  if (!result) {
    lines.push("Scan finished without a result snapshot.");
    return lines.join("\n");
  }

  lines.push("Scan complete");
  lines.push(`  Source: ${result.source}`);
  lines.push(
    `  Processed ${result.processed} / ${result.total} · New ${result.newContacts} · Updated ${result.updatedContacts} · Relationships ${result.relationshipsDiscovered} · Communities ${result.communities}`
  );
  lines.push(
    `  Index: ${result.index.scanned} scanned, ${result.index.indexed} written, ${result.index.skipped} unchanged${
      result.index.keywordIndexAvailable ? " · FTS available" : ""
    }`
  );
  lines.push(
    result.enrichment.configured
      ? `  Enrichment: ${result.enrichment.progress}% · ${result.enrichment.enriched} enriched${
          result.enrichment.providers.length > 0
            ? ` via ${result.enrichment.providers.join(", ")}`
            : ""
        }${result.enrichment.error ? ` · error: ${result.enrichment.error}` : ""}`
      : "  Enrichment: not configured — skipped (NetPro scanned everything offline)"
  );
  return lines.join("\n");
}

export function registerScanCommand(program: Command): void {
  const cmd = program
    .command("scan")
    .description("Reindex, enrich, and analyze the network in one observable sweep")
    .option("--source <name>", "Source label recorded on the scan job (default linkedin_csv)")
    .option("--no-enrich", "Skip enrichment even when a provider is configured")
    .option("--local", "Run in this process instead of delegating to a running NetPro server")
    .option("--server <url>", "NetPro server to delegate to (default 127.0.0.1:3777)")
    .option("--json", "Print the job and result snapshot as JSON")
    .action(async (options: ScanCommandOptions) => {
      try {
        // Same shape as every other command: open the database and resolve the
        // workspace scope once per invocation. A delegated scan does not use
        // them, but the in-process fallback (no server running) does.
        const { openDb, resolveCliScope } = await import("../db");
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const execution = await executeScan(options, { conn, scope });
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                mode: execution.mode,
                serverUrl: execution.serverUrl,
                job: execution.job,
                result: execution.result,
              },
              null,
              2
            )
          );
          return;
        }
        console.log(formatScan(execution));
      } catch (e) {
        console.error(`netpro scan: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
