// apps/cli/src/lib/jobs.ts
//
// Phase 7 — CLI shares the server's job model.
//
// The plan's exit criteria: "CLI and server use the same job model."
// Both import the canonical types and registry from @netpro/server so a
// `netpro scan` triggered from the CLI and a scan triggered from the Web UI
// look identical to the event stream. No second job shape is invented here.

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

/**
 * Best-effort forward an event to the local NetPro server when it is running.
 * The server's EventBus is the canonical fan-out for the Web UI; a CLI that
 * can reach the server contributes to that same stream.
 *
 * Uses global fetch with a short timeout so a non-running server does not
 * delay the CLI.
 */
async function forwardToServer(event: import('@netpro/server').NetProEvent): Promise<void> {
  const base =
    process.env.NETPRO_SERVER_URL?.trim() ||
    process.env.NEXT_PUBLIC_NETPRO_SERVER_URL?.trim() ||
    'http://127.0.0.1:3777';
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
    await fetch(`${base.replace(/\/$/, '')}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    }).catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}
