// packages/server/src/routes/jobs.ts
//
// Job API — the observable execution record for Phase 7.
//
// GET  /api/jobs               → list (filter by type/status, paginated)
// GET  /api/jobs/:id           → one job
// POST /api/jobs               → create a job skeleton (queued) — used by
//                                future scan/enrich/index/embed/graph/analyze
//                                triggers; import/scan have dedicated routes
// POST /api/jobs/:id/cancel    → cancel a queued/running job
//
// Jobs are the one operation model for CLI and server. The web UI polls this
// endpoint or subscribes to GET /api/events to watch progress.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJsonBody } from '../middleware/json';
import type { JobRegistry } from '../jobs/index';
import { isJobStatus, isJobType, JOB_TYPES } from '../jobs/index';
import type { EventBus } from '../events/index';
import type { AuthContext } from '../auth/index';
import type { SqliteConn, PgConn } from '@netpro/db';

export type JobsDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  jobs: JobRegistry;
  events: EventBus;
};

function num(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

export async function handleListJobs(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const typeParam = p.get('type')?.trim();
  const statusParam = p.get('status')?.trim();
  if (typeParam && !isJobType(typeParam)) {
    sendJson(res, 400, { error: `Unknown job type "${typeParam}". Expected one of: ${JOB_TYPES.join(', ')}.` });
    return;
  }
  if (statusParam && !isJobStatus(statusParam)) {
    sendJson(res, 400, { error: `Unknown job status "${statusParam}".` });
    return;
  }
  const limit = num(p.get('limit'), 25);
  const offset = num(p.get('offset'), 0);
  const type = typeParam as never;
  const status = statusParam as never;
  const jobs = deps.jobs.list({ type, status, limit, offset });
  const total = deps.jobs.total({ type, status });
  sendJson(res, 200, { jobs, total, limit: Math.min(Math.max(limit, 1), 200), offset: Math.max(offset, 0) });
}

export async function handleGetJob(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsDeps,
  id: string
): Promise<void> {
  if (!id) {
    sendJson(res, 400, { error: 'Job id is required.' });
    return;
  }
  const job = deps.jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: `No job with id "${id}".`, code: 'not_found' });
    return;
  }
  sendJson(res, 200, { job });
}

export async function handleCreateJob(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsDeps
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!isJobType(type)) {
    sendJson(res, 400, { error: `Unknown job type "${type}". Expected one of: ${JOB_TYPES.join(', ')}.` });
    return;
  }
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? (body.metadata as Record<string, unknown>)
    : {};
  try {
    const job = deps.jobs.create({ type, metadata });
    deps.events.publish({ type: 'job.queued', jobId: job.id, progress: job.progress });
    sendJson(res, 201, { job });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleCancelJob(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsDeps,
  id: string
): Promise<void> {
  if (!id) {
    sendJson(res, 400, { error: 'Job id is required.' });
    return;
  }
  const job = deps.jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: `No job with id "${id}".`, code: 'not_found' });
    return;
  }
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    sendJson(res, 409, { error: `Job "${id}" is already ${job.status}.`, job });
    return;
  }
  const cancelled = deps.jobs.cancel(id)!;
  deps.events.publish({ type: 'job.cancelled', jobId: id });
  sendJson(res, 200, { job: cancelled });
}
