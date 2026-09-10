// packages/server/src/middleware/json.ts
// Minimal HTTP helpers for the Node HTTP server — no framework.

import type { ServerResponse, IncomingMessage } from 'node:http';

export type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null | unknown;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Cache-Control': 'no-store, max-age=0' });
  res.end();
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(body);
}

// ── Body parsing ───────────────────────────────────────────────────────

/** Read the full request body as a Buffer (16 KiB default, 5 MiB max for imports). */
export async function readBody(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {}
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? 16 * 1024;
  const lengthHeader = req.headers['content-length'];
  if (lengthHeader) {
    const n = Number(lengthHeader);
    if (!Number.isNaN(n) && n > maxBytes) {
      throw Object.assign(new Error(`Request body must be ${maxBytes / 1024} KiB or smaller.`), { status: 413 });
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk as unknown as string) ? (chunk as Buffer) : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      // Drain the rest so the socket can be reused.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).destroy?.();
      throw Object.assign(new Error(`Request body must be ${maxBytes / 1024} KiB or smaller.`), { status: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage, opts: { maxBytes?: number } = {}): Promise<Record<string, unknown>> {
  const rawCt = req.headers['content-type'];
  const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt ?? '').split(';')[0].trim().toLowerCase();
  if (ct && ct !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  }
  const buf = await readBody(req, opts);
  if (buf.length === 0) throw Object.assign(new Error('A JSON body is required.'), { status: 400 });
  const text = buf.toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function _ensureBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk ?? ''));
}

export function errorStatus(error: unknown): number | null {
  const s = (error as { status?: unknown })?.status;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
