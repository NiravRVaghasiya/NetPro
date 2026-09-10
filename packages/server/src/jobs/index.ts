// packages/server/src/jobs/index.ts
//
// Phase 7 — observable job system (shared by CLI and server).
//
// Every long-running NetPro operation — import, scan, enrich, index, embed,
// graph, analyze — is a Job the UI can observe in real time. CLI and server
// share one model so `netpro scan` and a Web UI-triggered scan look identical
// to the event stream. Routes orchestrate; jobs are the execution record.
//
// Shape matches the plan verbatim:
//
//   Job
//   ├── id
//   ├── type
//   ├── status
//   ├── progress
//   ├── started_at  (startedAt)
//   ├── completed_at(completedAt)
//   ├── error
//   └── metadata
//
// Types / statuses are the plan's whitelists. `progress` is 0–100.
//

import { randomUUID } from 'node:crypto';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobType =
  | 'import'
  | 'scan'
  | 'enrich'
  | 'index'
  | 'embed'
  | 'graph'
  | 'analyze';

export const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export const JOB_TYPES: readonly JobType[] = [
  'import',
  'scan',
  'enrich',
  'index',
  'embed',
  'graph',
  'analyze',
] as const;

export function isJobStatus(v: unknown): v is JobStatus {
  return typeof v === 'string' && (JOB_STATUSES as readonly string[]).includes(v);
}
export function isJobType(v: unknown): v is JobType {
  return typeof v === 'string' && (JOB_TYPES as readonly string[]).includes(v);
}

/**
 * A single observable operation.
 *
 * `progress` is an integer 0–100 (queued = 0, completed = 100). `startedAt`
 * is set when the job leaves `queued`; `completedAt` when it reaches a
 * terminal status. `error` carries the failure message when `failed`.
 * `metadata` is the caller-supplied context (CSV filename, enrichment source,
 * graph limits, etc) and whatever result facts the operation chose to record
 * on completion (e.g. { imported: 12, merged: 3 }).
 *
 * The API serializes both camel and snake forms (`startedAt` + `started_at`)
 * so plan examples using `started_at` work without breaking existing tests
 * that read `startedAt`.
 */
export type Job = {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  startedAt: string | null;
  started_at?: string | null;
  completedAt: string | null;
  completed_at?: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  /** Created/updated are optional on fixtures — `put()` and `create()` guarantee them. */
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  [k: string]: unknown;
};

/** JSON shape the HTTP API returns — includes both casings. */
export type JobJson = Job & {
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Attach snake_case aliases so plan examples deserialize either way. */
function aliasJob(job: Job): Job {
  job.started_at = job.startedAt;
  job.completed_at = job.completedAt;
  job.created_at = job.createdAt;
  job.updated_at = job.updatedAt;
  return job;
}

export type CreateJobInput = {
  id?: string;
  type: JobType;
  metadata?: Record<string, unknown>;
  /** Initial status — default `queued`. */
  status?: JobStatus;
  /** Initial progress — default 0, forced to 100 for `completed`. */
  progress?: number;
};

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  /** Create a new job in `queued` (or the requested status). */
  create(input: CreateJobInput): Job {
    if (!isJobType(input.type)) {
      throw new Error(`Unknown job type \"${input.type}\". Expected one of: ${JOB_TYPES.join(', ')}.`);
    }
    const status: JobStatus = input.status ?? 'queued';
    if (!isJobStatus(status)) throw new Error(`Unknown job status \"${status}\".`);
    const id = input.id ?? randomUUID();
    if (this.jobs.has(id)) throw new Error(`Job \"${id}\" already exists.`);
    const t = nowIso();
    const progress = status === 'completed' ? 100 : clampProgress(input.progress ?? 0);
    const startedAt = status === 'queued' ? null : t;
    const completedAt = status === 'completed' || status === 'failed' || status === 'cancelled' ? t : null;
    const job: Job = aliasJob({
      id,
      type: input.type,
      status,
      progress,
      startedAt,
      completedAt,
      error: null,
      metadata: input.metadata ? { ...input.metadata } : {},
      createdAt: t,
      updatedAt: t,
    });
    this.jobs.set(id, job);
    return job;
  }

  list(filter?: { type?: JobType; status?: JobStatus; limit?: number; offset?: number }): Job[] {
    let out = [...this.jobs.values()];
    // Newest first — the UI's activity list shows recent jobs on top.
    out.sort((a, b) => {
      const ca = a.createdAt ?? '';
      const cb = b.createdAt ?? '';
      return ca < cb ? 1 : ca > cb ? -1 : 0;
    });
    if (filter?.type) out = out.filter((j) => j.type === filter.type);
    if (filter?.status) out = out.filter((j) => j.status === filter.status);
    const offset = Math.max(filter?.offset ?? 0, 0);
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 200);
    return out.slice(offset, offset + limit);
  }

  total(filter?: { type?: JobType; status?: JobStatus }): number {
    let out = [...this.jobs.values()];
    if (filter?.type) out = out.filter((j) => j.type === filter.type);
    if (filter?.status) out = out.filter((j) => j.status === filter.status);
    return out.length;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Register a full job snapshot (tests / future persistent workers). */
  put(job: Job): void {
    // Ensure aliases and updatedAt are coherent even for fixtures.
    if (!job.createdAt) job.createdAt = nowIso();
    if (!job.updatedAt) job.updatedAt = job.createdAt;
    job.updatedAt = job.updatedAt ?? nowIso();
    aliasJob(job);
    job.progress = clampProgress(job.progress);
    this.jobs.set(job.id, job);
  }

  /** Transition `queued` → `running`. Sets startedAt when first running. */
  start(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'running') return job;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    job.status = 'running';
    job.startedAt = job.startedAt ?? nowIso();
    job.started_at = job.startedAt;
    if (job.progress === 0) job.progress = 5;
    job.updatedAt = nowIso();
    job.updated_at = job.updatedAt;
    return job;
  }

  /** Update progress 0–100. Also moves `queued` → `running` implicitly. */
  updateProgress(id: string, progress: number, metadataPatch?: Record<string, unknown>): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.progress = clampProgress(progress);
    if (metadataPatch) job.metadata = { ...job.metadata, ...metadataPatch };
    if (job.status === 'queued' && job.progress > 0) {
      job.status = 'running';
      job.startedAt = job.startedAt ?? nowIso();
      job.started_at = job.startedAt;
    }
    if (job.status === 'running' && job.progress >= 100) {
      job.status = 'completed';
      job.completedAt = nowIso();
      job.completed_at = job.completedAt;
    }
    job.updatedAt = nowIso();
    job.updated_at = job.updatedAt;
    return job;
  }

  /** Mark `completed` at 100 %. */
  complete(id: string, metadataPatch?: Record<string, unknown>): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = 'completed';
    job.progress = 100;
    job.startedAt = job.startedAt ?? nowIso();
    job.started_at = job.startedAt;
    job.completedAt = nowIso();
    job.completed_at = job.completedAt;
    if (metadataPatch) job.metadata = { ...job.metadata, ...metadataPatch };
    job.error = null;
    job.updatedAt = job.completedAt;
    job.updated_at = job.updatedAt;
    return job;
  }

  /** Mark `failed` with an error message. */
  fail(id: string, error: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = 'failed';
    job.error = String(error).slice(0, 5000);
    job.completedAt = nowIso();
    job.completed_at = job.completedAt;
    job.updatedAt = job.completedAt;
    job.updated_at = job.updatedAt;
    return job;
  }

  /** Mark `cancelled`. Only queued/running can be cancelled. */
  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    job.status = 'cancelled';
    job.completedAt = nowIso();
    job.completed_at = job.completedAt;
    job.updatedAt = job.completedAt;
    job.updated_at = job.updatedAt;
    return job;
  }

  /** Remove a job (retention / tests). */
  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  clear(): void {
    this.jobs.clear();
  }
}

export function createJobRegistry(): JobRegistry {
  return new JobRegistry();
}

/** Shape the HTTP API guarantees for a job listing. */
export function jobToJson(job: Job): JobJson {
  aliasJob(job);
  return job as JobJson;
}
