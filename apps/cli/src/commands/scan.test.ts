import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import type { Job } from "@netpro/server";
import { executeScan, formatScan } from "./scan";

type Handle = ReturnType<typeof createTestSqliteConn>;

const savedEnv = { ...process.env };

function insertContact(sqlite: Handle["sqlite"], id: string, fullName: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO contacts (id, workspace_id, full_name, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(id, "default", fullName, "test", now, now);
}

/** An SSE body: two frames, then close. */
function eventStream(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const SCAN_RESULT = {
  source: "linkedin_csv",
  processed: 2,
  total: 2,
  newContacts: 2,
  updatedContacts: 0,
  relationships: 0,
  relationshipsDiscovered: 0,
  communities: 0,
  enrichment: { configured: false, providers: [], enriched: 0, progress: 0, skipped: 0, error: null },
  index: { scanned: 2, indexed: 2, skipped: 0, pruned: 0, keywordIndexAvailable: true },
  graph: { nodes: 2, edges: 0, pendingCandidates: 0, communities: 0 },
  providers: null,
  startedAt: "2026-09-10T00:00:00.000Z",
  completedAt: "2026-09-10T00:00:05.000Z",
};

describe("netpro scan", () => {
  let handle: Handle;

  beforeEach(() => {
    handle = createTestSqliteConn();
    process.env.NETPRO_NO_FORWARD = "1";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("runs the sweep in-process and prints the plan's progress narrative", async () => {
    insertContact(handle.sqlite, "s1", "Jane Doe");
    insertContact(handle.sqlite, "s2", "John Smith");

    const execution = await executeScan({}, { conn: handle.conn, probe: async () => false });
    const text = formatScan(execution);

    expect(execution.mode).toBe("local");
    expect(execution.job?.type).toBe("scan");
    expect(execution.job?.status).toBe("completed");
    expect(execution.result?.index).toMatchObject({ scanned: 2, indexed: 2 });

    expect(text).toContain("Scan started");
    expect(text).toContain("Scan complete");
    // The ladder from the plan: percentages climbing to 100.
    expect(text).toMatch(/15%/);
    expect(text).toMatch(/40%/);
    expect(text).toMatch(/100%/);
    expect(text).toContain("Processed 2 / 2");
  });

  it("publishes scan.* events into the shared job + event model", async () => {
    const execution = await executeScan({}, { conn: handle.conn, probe: async () => false });
    const types = execution.events.map((e) => e.type);

    expect(types).toContain("job.queued");
    expect(types).toContain("job.running");
    expect(types).toContain("scan.started");
    expect(types).toContain("scan.progress");
    expect(types).toContain("scan.completed");
    expect(types).toContain("job.completed");
    // Every event carries the job id the Web UI correlates on.
    for (const event of execution.events) {
      expect(event.jobId ?? event.type === "job.queued").toBeTruthy();
    }
    expect(execution.events.at(-1)?.type).toBe("job.completed");
  });

  it("delegates to a running NetPro server and replays its job's events", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/scan")) {
        return new Response(JSON.stringify({ job: { id: "job-abcdef", type: "scan", status: "completed", progress: 100 }, result: SCAN_RESULT }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return eventStream([
        { type: "scan.started", jobId: "job-abcdef", progress: 0, message: "Scan queued" },
        { type: "scan.progress", jobId: "job-abcdef", progress: 23, message: "Processing contacts" },
        { type: "scan.progress", jobId: "job-abcdef", progress: 68, message: "Analyzing graph" },
        { type: "scan.completed", jobId: "job-abcdef", progress: 100, message: "Scan complete" },
      ]);
    }) as unknown as typeof fetch;

    const execution = await executeScan(
      {},
      {
        conn: handle.conn,
        serverUrl: "http://127.0.0.1:3777",
        probe: async () => true,
        fetchImpl,
      }
    );

    expect(execution.mode).toBe("server");
    expect(execution.job?.id).toBe("job-abcdef");
    expect(execution.result?.processed).toBe(2);
    // POST /api/scan is the same route the Web UI triggers — one job system.
    const post = calls.find((c) => c.url.endsWith("/api/scan"));
    expect(post?.init?.method).toBe("POST");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ origin: "cli" });
    // …and the terminal watches that job on the server's SSE stream.
    expect(calls.some((c) => c.url.includes("/api/events/stream?jobId=job-abcdef"))).toBe(true);

    const text = formatScan(execution);
    expect(text).toContain("23%");
    expect(text).toContain("68%");
    expect(text).toContain("Scan complete");
  });

  it("runs locally with --local even when a server is reachable", async () => {
    const execution = await executeScan(
      { local: true },
      { conn: handle.conn, serverUrl: "http://127.0.0.1:3777", probe: async () => true }
    );
    expect(execution.mode).toBe("local");
  });

  it("falls back to the local sweep when the server cannot run the scan", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const execution = await executeScan(
      {},
      { conn: handle.conn, serverUrl: "http://127.0.0.1:3777", probe: async () => true, fetchImpl }
    );
    expect(execution.mode).toBe("local");
    expect(execution.result).not.toBeNull();
  });

  it("reports enrichment as skipped when no provider is configured", async () => {
    const execution = await executeScan({}, { conn: handle.conn, env: {}, probe: async () => false });
    expect(execution.result?.enrichment.configured).toBe(false);
    expect(formatScan(execution)).toContain("Enrichment: not configured — skipped");
  });
});

describe("formatScan", () => {
  it("prints a usable summary even when the stream never connected", () => {
    const text = formatScan({
      mode: "server",
      job: {
        id: "job-12345678",
        type: "scan",
        status: "completed",
        progress: 100,
        metadata: {},
      } as unknown as Job,
      result: SCAN_RESULT as unknown as never,
      serverUrl: "http://127.0.0.1:3777",
      events: [],
    });
    expect(text).toContain("Scan started on the NetPro server");
    expect(text).toContain("job-1234");
    expect(text).toContain("Processed 2 / 2");
  });

  it("says so when there is no result snapshot", () => {
    const text = formatScan({ mode: "local", job: null, result: null, serverUrl: null, events: [] });
    expect(text).toContain("without a result snapshot");
  });
});
