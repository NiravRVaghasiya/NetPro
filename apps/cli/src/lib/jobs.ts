// apps/cli/src/lib/jobs.ts
//
// Phase 7 — CLI shares the server's job model.
// Phase 16 — CLI shares the server's *event stream* too.
//
// The plan's exit criteria: "CLI and server use the same job model." Both
// import the canonical types and registry from @netpro/server so a `netpro
// scan` triggered from the CLI and a scan triggered from the Web UI look
// identical to the event stream. No second job shape is invented here.

export type { Job, JobType, JobStatus, JobJson, CreateJobInput } from '@netpro/server';
export {
  createJobRegistry,
  JobRegistry,
  JOB_TYPES,
  JOB_STATUSES,
  isJobType,
  isJobStatus,
  jobToJson,
} from '@netpro/server';
export type { NetProEvent } from '@netpro/server';
export { createEventBus, EventBus } from '@netpro/server';

import { createJobRegistry, createEventBus } from '@netpro/server';
import type { Job, JobType, NetProEvent } from '@netpro/server';

/** Where the local NetPro server lives (same precedence as the Web UI). */
export function resolveServerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.NETPRO_SERVER_URL?.trim() ||
    env.NETPRO_URL?.trim() ||
    env.NEXT_PUBLIC_NETPRO_SERVER_URL?.trim() ||
    'http://127.0.0.1:3777';
  return raw.replace(/\/+$/, '');
}

/** Timeout for "is the server there?" probes — a local server answers at once. */
const PROBE_TIMEOUT_MS = 1_200;

/**
 * Best-effort reachability probe. Used to decide whether a CLI operation can
 * delegate to (or at least report into) a running NetPro server. Never throws.
 */
export async function serverReachable(
  baseUrl: string = resolveServerBaseUrl(),
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (process.env.NETPRO_NO_FORWARD === '1') return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort forward an event to the local NetPro server when it is running.
 * The server's EventBus is the canonical fan-out for the Web UI; a CLI that
 * can reach the server contributes to that same stream.
 *
 * Uses global fetch with a short timeout so a non-running server does not
 * delay the CLI.
 */
async function forwardToServer(event: NetProEvent): Promise<void> {
  const base = resolveServerBaseUrl();
  // Never try to forward when the caller explicitly disabled it.
  if (process.env.NETPRO_NO_FORWARD === '1') return;
  // Probe health first would double latency — just try the event endpoint and
  // let the network tell us if nobody is listening. fetch in Node throws
  // ECONNREFUSED quickly (<50 ms on loopback).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    // The server guards /api/events with auth; a loopback request is trusted
    // in `local` mode, so no token is needed for the default local setup.
    // In token/open modes the CLI already holds the token via NETPRO_AUTH_TOKEN
    // and can add it via Authorization — but that is not required for the
    // plan's "local-first" exit criteria, so we forward without auth and let
    // the server decide (401 is silently ignored here).
    await fetch(`${base}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    }).catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run a core operation as a Job, publishing progress to an optional EventBus.
 * Used by CLI commands that want the same observable shape as the server.
 *
 * Phase 8 — when a local NetPro server is running (http://127.0.0.1:3777 by
 * default, or NETPRO_SERVER_URL), the same events are forwarded to it via
 * fetch so a `netpro import` or `netpro scan` started in a terminal shows up
 * instantly in the Web UI's Activity feed without the user needing to poll.
 * Forwarding is best-effort: if the server is not reachable the CLI still
 * succeeds and the local EventBus still records the job.
 *
 * Example:
 *   const registry = createJobRegistry();
 *   const bus = createEventBus();
 *   const job = registry.create({ type: 'import', metadata: { file } });
 *   await runWithJob(job.id, registry, bus, async (update) => {
 *     update(15, 'parsing');
 *     const summary = await runImport(csv, conn);
 *     update(90, 'indexing');
 *     return summary;
 *   });
 */
export async function runWithJob<T>(
  jobId: string,
  registry: import('@netpro/server').JobRegistry,
  bus: import('@netpro/server').EventBus | null,
  fn: (update: (progress: number, message?: string, metadataPatch?: Record<string, unknown>) => void) => Promise<T>
): Promise<{ job: import('@netpro/server').Job; result: T }> {
  registry.start(jobId);
  bus?.publish({ type: 'job.running', jobId, progress: 5 });
  void forwardToServer({ type: 'job.running', jobId, progress: 5 }).catch(() => {});
  const update = (progress: number, message?: string, patch?: Record<string, unknown>) => {
    registry.updateProgress(jobId, progress, patch);
    bus?.publish({ type: 'job.progress', jobId, progress, message, ...(patch ?? {}) });
    void forwardToServer({ type: 'job.progress', jobId, progress, message, ...(patch ?? {}) }).catch(() => {});
  };
  try {
    const result = await fn(update);
    registry.complete(jobId, { result } as Record<string, unknown>);
    bus?.publish({ type: 'job.completed', jobId, progress: 100, result });
    void forwardToServer({ type: 'job.completed', jobId, progress: 100 }).catch(() => {});
    return { job: registry.get(jobId)!, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.fail(jobId, message);
    bus?.publish({ type: 'job.failed', jobId, error: message });
    void forwardToServer({ type: 'job.failed', jobId, error: message }).catch(() => {});
    throw error;
  }
}

// ── Phase 16 — one job + one event stream, from the terminal ───────────────

/**
 * What a CLI operation can publish through while it runs:
 *   * `update()`  — job progress (0–100) plus a stage message
 *   * `publish()` — a domain event (`scan.progress`, `import.completed`, …)
 *
 * Both go to the local EventBus and, best-effort, to the running server, so
 * the Web UI's Activity feed and Scan/Import views show a terminal operation
 * as it happens.
 */
export type CliJobEmitter = {
  update(progress: number, message?: string, patch?: Record<string, unknown>): void;
  publish(event: NetProEvent): void;
};

export type RunCliJobOptions<T> = {
  type: JobType;
  metadata?: Record<string, unknown>;
  /** Called for every event, in order — the CLI prints progress from here. */
  onEvent?: (event: NetProEvent) => void;
  run: (emit: CliJobEmitter) => Promise<T>;
};

export type CliJobResult<T> = {
  job: Job;
  result: T;
  /** Every event this operation published, oldest first. */
  events: NetProEvent[];
};

/**
 * Run a core operation as a Job inside the CLI.
 *
 * This is the CLI half of "one job system, one event stream": the registry and
 * event types come from `@netpro/server`, the same module the HTTP server
 * uses, so a job created here and a job created by `POST /api/scan` are the
 * same shape. Events are mirrored to the running server when there is one, so
 * the Web UI observes the terminal run without polling.
 */
export async function runCliJob<T>(options: RunCliJobOptions<T>): Promise<CliJobResult<T>> {
  const registry = createJobRegistry();
  const bus = createEventBus();
  const job = registry.create({ type: options.type, metadata: options.metadata ?? {} });
  const events: NetProEvent[] = [];
  let forwarding = true;

  const emit = (event: NetProEvent): void => {
    const published = bus.publish(event);
    events.push(published);
    options.onEvent?.(published);
    if (forwarding) {
      void forwardToServer(published).catch(() => {
        // One failure is enough: every later event would fail the same way,
        // and retrying only adds latency to the rest of the operation.
        forwarding = false;
      });
    }
  };

  const emitters: CliJobEmitter = {
    update(progress, message, patch) {
      registry.updateProgress(job.id, progress, patch);
      emit({ type: 'job.progress', jobId: job.id, progress, message, ...(patch ?? {}) });
    },
    publish(event) {
      emit({ ...event, jobId: event.jobId ?? job.id });
    },
  };

  registry.start(job.id);
  emit({
    type: 'job.queued',
    jobId: job.id,
    progress: 0,
    ...(options.metadata?.source ? { source: options.metadata.source } : {}),
  });
  emit({ type: 'job.running', jobId: job.id, progress: 5 });

  try {
    const result = await options.run(emitters);
    registry.complete(job.id, { result } as Record<string, unknown>);
    emit({ type: 'job.completed', jobId: job.id, progress: 100 });
    return { job: registry.get(job.id)!, result, events };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.fail(job.id, message);
    emit({ type: 'job.failed', jobId: job.id, error: message });
    throw error;
  }
}
