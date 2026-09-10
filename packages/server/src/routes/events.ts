// packages/server/src/routes/events.ts
//
// GET /api/events — Server-Sent Events transport (Phase 8).
//
// A single in-process EventBus fans out domain events (scan.progress,
// import.completed, job.failed, ...) to every connected browser tab.
// The Web UI connects with EventSource:
//
//   new EventSource('/api/events?token=…')
//
// The server authenticates the request exactly like every other API route
// (loopback or bearer token). After the 200 header, it never closes the
// response — events are flushed as `data: <json>\\n\\n`. A comment ping every
// 20 s keeps proxies from timing the stream out, and a `retry: 3000` tells
// EventSource how quickly to reconnect.
//
// Query filters (all optional):
//   ?type=scan.progress&type=import.completed   — only those types
//   ?jobId=abc123                                — only that job
//   ?history=10                                  — replay last N buffered events immediately
//   Last-Event-ID header is also honoured: events with seq > that value are replayed.
//
// This file contains only transport. Event *types* are defined in
// ../events/index.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventBus, NetProEvent } from '../events/index';

export type EventsDeps = {
  events: EventBus;
};

function sseLine(field: string, value: string): string {
  // SSE field values must not contain bare newlines — strip them.
  const sanitized = value.replace(/\r?\n/g, ' ');
  return `${field}: ${sanitized}\n`;
}

function writeEvent(res: ServerResponse, event: NetProEvent): void {
  // `type` maps to the SSE `event:` field so the browser can addEventListener(type).
  if (event.type) res.write(sseLine('event', String(event.type)));
  // `id` lets EventSource send Last-Event-ID on reconnection.
  if (event.seq !== undefined) res.write(sseLine('id', String(event.seq)));
  res.write(sseLine('data', JSON.stringify(event)));
  res.write('\n');
}

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EventsDeps
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const typeFilter = url.searchParams.getAll('type').filter(Boolean);
  const jobIdFilter =
    url.searchParams.get('jobId')?.trim() || url.searchParams.get('job_id')?.trim() || undefined;
  const historyParam = url.searchParams.get('history');
  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventIdFromHeader =
    typeof lastEventIdHeader === 'string' ? Number(lastEventIdHeader) : undefined;
  const lastEventIdFromQuery = url.searchParams.get('lastEventId')
    ? Number(url.searchParams.get('lastEventId'))
    : undefined;
  const lastEventId = Number.isFinite(lastEventIdFromHeader as number)
    ? (lastEventIdFromHeader as number)
    : Number.isFinite(lastEventIdFromQuery as number)
      ? (lastEventIdFromQuery as number)
      : undefined;

  // SSE must disable buffering and caching; Node's `writeHead` before the
  // first `write` ensures proxies forward chunks immediately.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Connection: 'keep-alive',
    // Nginx buffering off (also honoured by most CDNs/proxies when present).
    'X-Accel-Buffering': 'no',
  });

  // The browser spec wants an initial `retry` so reconnections are prompt
  // but not aggressive (3 s).
  res.write('retry: 3000\n\n');
  // A comment line — EventSource ignores it, but the TCP keep-alive keeps
  // intermediate proxies from closing an idle stream.
  res.write(': connected\n\n');

  const shouldSend = (event: NetProEvent): boolean => {
    if (typeFilter.length > 0 && !typeFilter.includes(event.type)) return false;
    if (jobIdFilter && event.jobId !== jobIdFilter) return false;
    return true;
  };

  // Replay buffered history so a late joiner immediately sees recent activity.
  // The plan's exit criteria is "a running CLI/server operation produces events
  // visible to the Web UI" — that includes a UI that opened *after* the job
  // started. Replay is bounded: `?history=` caps it, default is all buffered.
  // When `Last-Event-ID` is present, only events newer than that ID are sent.
  try {
    let replay: NetProEvent[] = [];
    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      replay = deps.events.getHistory().filter((e) => (e.seq ?? 0) > (lastEventId as number));
    } else if (historyParam !== null) {
      const n = Number(historyParam);
      const limit = Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), 200)) : 0;
      replay = limit === 0 ? [] : deps.events.getHistory(limit);
    } else {
      // Default: replay up to 20 recent events — enough to populate Activity
      // without flooding a new tab with hundreds of lines. The UI can request
      // more with `?history=100` if it wants a fuller backlog.
      replay = deps.events.getHistory(20);
    }
    for (const event of replay) {
      if (!shouldSend(event)) continue;
      writeEvent(res, event);
    }
  } catch {
    // Replay is best-effort — a failure must not break the live stream.
  }

  const unsubscribe = deps.events.subscribe((event) => {
    if (!shouldSend(event)) return;
    try {
      writeEvent(res, event);
    } catch {
      // Client disconnected mid-write — ignore.
    }
  });

  // Periodic ping so the stream is never truly idle.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // Socket closed — the 'close' handler will clean up.
    }
  }, 20_000);

  const cleanup = (): void => {
    clearInterval(ping);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  // `error` on the request socket is already handled by `close`.
}

// POST /api/events/ingest — Phase 8 CLI→server bridge.
//
// The CLI's `runWithJob` forwards job.* events via fetch when the local server
// is running, so a terminal operation appears in the Web UI's Activity feed.
// This endpoint is authenticated exactly like every other API route (loopback
// in `local` mode, bearer token otherwise) and simply re-publishes the body
// onto the same EventBus the SSE transport fans out.
export async function handleEventsIngest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EventsDeps
): Promise<void> {
  const { readJsonBody } = await import('../middleware/json');
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!type) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Event `type` is required.' }));
    return;
  }
  // Published event is the body's JSON plus bus timestamp/seq. The body may
  // carry jobId, progress, message, etc. — we trust the caller for those
  // fields and the bus stamps its own timestamp/seq.
  const event = { ...body, type } as NetProEvent;
  deps.events.publish(event);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, event }));
}

// Also exported for tests that want to assert the event shape without SSE.
export { writeEvent as _writeEventForTests };
