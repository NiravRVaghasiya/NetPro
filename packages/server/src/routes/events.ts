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
// response — events are flushed as `data: <json>\n\n`. A comment ping every
// 20 s keeps proxies from timing the stream out, and a `retry: 3000` tells
// EventSource how quickly to reconnect.
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
  res.write(sseLine('data', JSON.stringify(event)));
  res.write('\n');
}

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EventsDeps
): void {
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

  const unsubscribe = deps.events.subscribe((event) => {
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

// Also exported for tests that want to assert the event shape without SSE.
export { writeEvent as _writeEventForTests };
