// packages/server/src/middleware/json.ts
// Minimal JSON response helpers for the Node HTTP server.

import type { ServerResponse } from 'node:http';

export type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: JsonBody,
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
