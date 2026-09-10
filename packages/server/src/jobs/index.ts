// packages/server/src/jobs/index.ts
//
// Phase 1 scaffold for the job system (full model in Phase 7).
// Orchestration only — business work stays in @netpro/core.

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

export type Job = {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

/** In-memory job registry. Phase 7 will persist and share with the CLI. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  list(): Job[] {
    return [...this.jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Register a job snapshot (tests / future workers). */
  put(job: Job): void {
    this.jobs.set(job.id, job);
  }
}

export function createJobRegistry(): JobRegistry {
  return new JobRegistry();
}
