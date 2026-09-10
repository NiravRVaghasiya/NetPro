// packages/server/src/routes/import.ts
//
// POST /api/import
// POST /api/import/preview
// GET  /api/import/:id
//
// The Web UI trigger for `runImport` (the same CSV pipeline the CLI uses).
// Phase 7 wraps every import in a Job so progress is observable: the route
// creates a job `queued` → `running` → `completed|failed`, emits
// `import.*` events through the EventBus, and records the ImportSummary in
// job.metadata.result so GET /api/import/:id (alias: GET /api/jobs/:id) can
// retrieve it later.
//
// Phase 15 — `POST /api/import/preview` runs core's `previewImport` (parse +
// validate, no database writes) so the Web UI's Upload → Preview → Validate →
// Import flow shares the exact validation the real import performs.
//
// There is exactly one import implementation: @netpro/core/src/import.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { runImport, previewImport } from '@netpro/core/src/import';
import { sendJson, readBody } from '../middleware/json';
import type { JobRegistry } from '../jobs/index';
import type { EventBus } from '../events/index';
import type { AuthContext } from '../auth/index';

export type ImportDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  jobs: JobRegistry;
  events: EventBus;
};

async function extractCsv(req: IncomingMessage): Promise<string> {
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  const buf = await readBody(req, { maxBytes: 5 * 1024 * 1024 });
  if (buf.length === 0) throw Object.assign(new Error('A CSV file is required.'), { status: 400 });
  const text = buf.toString('utf-8');

  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.csv === 'string' && parsed.csv.trim().length > 0) return parsed.csv;
      if (typeof parsed.file === 'string' && parsed.file.trim().length > 0) return parsed.file;
    } catch {
      // fall through to mime checks
    }
    throw Object.assign(new Error('A CSV file is required — send multipart/form-data with file, or JSON { csv }.'), { status: 400 });
  }

  if (ct.includes('multipart/form-data')) {
    const boundaryMatch = /boundary=([^;]+)/i.exec(req.headers['content-type'] ?? '');
    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!.trim().replace(/^"|"$/g, '');
      const parts = parseMultipart(buf, boundary);
      for (const p of parts) {
        if (p.filename || p.name === 'file' || p.name === 'csv') {
          if (p.data.length > 0) return p.data.toString('utf-8');
        }
      }
      // No file part — maybe the CSV was sent as a plain field.
      for (const p of parts) {
        const c = p.data.toString('utf-8').trim();
        if (c.length > 0) return c;
      }
    }
    throw Object.assign(new Error('A CSV file is required (multipart part named "file").'), { status: 400 });
  }

  // text/csv, text/plain, or no content-type — treat body as raw CSV.
  if (text.trim().length === 0) throw Object.assign(new Error('A CSV file is required.'), { status: 400 });
  return text;
}

type MultipartPart = { name?: string; filename?: string; headers: string; data: Buffer };

function parseMultipart(buf: Buffer, boundary: string): MultipartPart[] {
  const delimiter = `--${boundary}`;
  const text = buf.toString('binary');
  const rawParts = text.split(delimiter);
  const out: MultipartPart[] = [];
  for (let raw of rawParts) {
    raw = raw.trim();
    if (!raw || raw === '--') continue;
    if (raw.startsWith('--')) continue;
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = raw.slice(0, headerEnd);
    const bodyStart = headerEnd + 4;
    let body = raw.slice(bodyStart);
    // Trim trailing CRLF
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const disposition = /Content-Disposition:[^\r\n]*name="([^"]+)"/i.exec(headers);
    const filenameMatch = /filename="([^"]+)"/i.exec(headers);
    out.push({
      name: disposition?.[1],
      filename: filenameMatch?.[1],
      headers,
      data: Buffer.from(body, 'binary'),
    });
  }
  return out;
}

export async function handleImportPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportDeps
): Promise<void> {
  let csv: string;
  try {
    csv = await extractCsv(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message });
    return;
  }

  // Phase 7 job lifecycle for the import.
  const job = deps.jobs.create({ type: 'import', metadata: { source: 'api' } });
  deps.events.publish({ type: 'import.started', jobId: job.id, message: 'Import queued' });
  deps.events.publish({ type: 'job.queued', jobId: job.id, progress: 0 });
  deps.jobs.start(job.id);
  deps.events.publish({ type: 'job.running', jobId: job.id, progress: 5 });
  deps.events.publish({ type: 'import.progress', jobId: job.id, progress: 15, message: 'Parsing CSV' });
  deps.jobs.updateProgress(job.id, 15, { stage: 'parsing' });

  try {
    deps.events.publish({ type: 'import.progress', jobId: job.id, progress: 40, message: 'Writing contacts' });
    deps.jobs.updateProgress(job.id, 40);
    const summary = await runImport(csv, deps.conn);
    deps.events.publish({ type: 'import.progress', jobId: job.id, progress: 90, message: 'Indexing' });
    deps.jobs.updateProgress(job.id, 90);
    deps.jobs.complete(job.id, { result: summary, stage: 'completed' });
    const completed = deps.jobs.get(job.id)!;
    deps.events.publish({ type: 'import.completed', jobId: job.id, progress: 100, result: summary });
    deps.events.publish({ type: 'job.completed', jobId: job.id, progress: 100 });
    // Phase 8 — richer domain events so the Observatory can answer
    // "what did NetPro discover?" without parsing the import summary.
    if (summary.imported > 0) {
      deps.events.publish({
        type: 'contact.imported',
        jobId: job.id,
        imported: summary.imported,
        merged: summary.merged,
        message: `Imported ${summary.imported} new contacts`,
      });
    }
    if (summary.merged > 0) {
      deps.events.publish({
        type: 'contact.updated',
        jobId: job.id,
        imported: summary.imported,
        merged: summary.merged,
        message: `Updated ${summary.merged} existing contacts`,
      });
    }
    if (summary.edgeCandidates && summary.edgeCandidates.inserted > 0) {
      deps.events.publish({
        type: 'relationship.discovered',
        jobId: job.id,
        message: `Discovered ${summary.edgeCandidates.inserted} relationship candidates`,
        candidates: summary.edgeCandidates,
      });
    }
    if (summary.imported > 0 || summary.merged > 0) {
      deps.events.publish({
        type: 'graph.updated',
        jobId: job.id,
        message: summary.imported > 0 ? `Graph: +${summary.imported} contacts` : 'Graph updated',
        imported: summary.imported,
        merged: summary.merged,
      });
    }
    sendJson(res, 200, { job: completed, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.jobs.fail(job.id, message);
    deps.events.publish({ type: 'job.failed', jobId: job.id, error: message, message });
    deps.events.publish({ type: 'import.completed', jobId: job.id, error: message });
    sendJson(res, 500, { error: message, job: deps.jobs.get(job.id) });
  }
}

/**
 * Phase 15 — the "Preview / Validate" steps of the Web UI import flow.
 *
 * Runs `previewImport` (parse + validate, never writes) so the browser can
 * show the user exactly what will be imported and which rows will be skipped
 * before POSTing the CSV to `/api/import`. The preview path shares the same
 * core validation as the import, so a row the preview flags is a row the
 * import will skip.
 */
export async function handleImportPreviewPost(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: ImportDeps
): Promise<void> {
  let csv: string;
  try {
    csv = await extractCsv(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { error: message });
    return;
  }

  try {
    const preview = previewImport(csv);
    sendJson(res, 200, { preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
  }
}

export async function handleImportGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const id = url.pathname.split('/').pop() ?? '';
  if (!id) {
    sendJson(res, 400, { error: 'Import id is required.' });
    return;
  }
  const job = deps.jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: `No import job with id "${id}".`, code: 'not_found' });
    return;
  }
  if (job.type !== 'import') {
    sendJson(res, 404, { error: `Job "${id}" is not an import.`, code: 'not_found' });
    return;
  }
  sendJson(res, 200, { job });
}
