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
  const update = (progress: number, message?: string, patch?: Record<string, unknown>) => {
    registry.updateProgress(jobId, progress, patch);
    bus?.publish({ type: 'job.progress', jobId, progress, message, ...(patch ?? {}) });
  };
  try {
    const result = await fn(update);
    registry.complete(jobId, { result } as Record<string, unknown>);
    bus?.publish({ type: 'job.completed', jobId, progress: 100, result });
    return { job: registry.get(jobId)!, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.fail(jobId, message);
    bus?.publish({ type: 'job.failed', jobId, error: message });
    throw error;
  }
}
