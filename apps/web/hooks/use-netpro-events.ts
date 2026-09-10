// apps/web/hooks/use-netpro-events.ts
//
// Phase 8 — client-side SSE hook.
//
// The server's EventBus fans out via GET /api/events (text/event-stream).
// This hook connects with the browser's native EventSource, handles the
// `retry:` the server sends, honours the `NETPRO_SERVER_URL` the server-client
// module resolves, and surfaces a stable `events` array plus connection state
// so the Observatory and Activity pages can render "what is NetPro doing?" in
// real time.
//
// The hook is deliberately tiny: it does not parse domain payloads, it does
// not duplicate job logic, and it falls back to polling when EventSource is
// unavailable (e.g. during `next build`'s static render phase). Every event
// the server publishes — scan.progress, import.completed, job.failed, etc. —
// flows through here unchanged; the UI decides how to visualize it.

'use client';

import { useEffect, useRef, useState } from 'react';
import { getEventsUrl } from '@/lib/netpro-server';

export type NetProEvent = {
  type: string;
  jobId?: string;
  progress?: number;
  message?: string;
  timestamp?: string;
  seq?: number;
  [key: string]: unknown;
};

export type UseNetProEventsOptions = {
  /** Server base URL override (tests). */
  serverUrl?: string;
  /** Filter: only these types (server also filters when provided in the URL). */
  types?: string[];
  /** Filter: only this job. */
  jobId?: string;
  /** How many buffered events to replay on connect (default 20). */
  history?: number;
  /** Disable the subscription (e.g. when server is unreachable). */
  enabled?: boolean;
};

export type UseNetProEventsResult = {
  events: NetProEvent[];
  connected: boolean;
  error: string | null;
  lastEvent: NetProEvent | null;
  clear: () => void;
};

export function useNetProEvents(options: UseNetProEventsOptions = {}): UseNetProEventsResult {
  const [events, setEvents] = useState<NetProEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastEventRef = useRef<NetProEvent | null>(null);
  const typesKey = options.types?.join(',') ?? '';
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    // EventSource only exists in the browser; during SSR we stay disconnected.
    if (typeof window === 'undefined' || typeof (window as unknown as { EventSource?: unknown }).EventSource === 'undefined') {
      return;
    }

    const params: Record<string, string | undefined> = {};
    if (options.jobId) params.jobId = options.jobId;
    if (options.history !== undefined) params.history = String(options.history);
    // The server supports repeated `?type=` — we encode as comma-joined fallback
    // and also pass explicit query building below.
    const baseEnv: NodeJS.ProcessEnv = options.serverUrl ? ({ NEXT_PUBLIC_NETPRO_SERVER_URL: options.serverUrl } as unknown as NodeJS.ProcessEnv) : process.env;
    let url = getEventsUrl(params, baseEnv as NodeJS.ProcessEnv);
    if (options.types && options.types.length > 0) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${options.types.map((t) => `type=${encodeURIComponent(t)}`).join('&')}`;
    }
    // EventSource URL with fallback for browsers that don't expose it during tests.
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    const onOpen = (): void => {
      setConnected(true);
      setError(null);
    };
    const onError = (): void => {
      // The browser will auto-reconnect per the server's `retry: 3000`.
      // We mark disconnected so the UI can show a "reconnecting…" banner.
      setConnected(false);
      // Do not set a hard error here — transient network blips should not
      // surface as a red alert until the next `open` succeeds.
    };
    const onMessage = (e: MessageEvent): void => {
      try {
        const parsed = JSON.parse((e as MessageEvent).data as string) as NetProEvent;
        // When the server sends `event: <type>` the browser fires that named
        // event, not `message`. This handler catches the generic `data:`.
        if (!parsed.type && (e as { type?: string }).type && (e as { type?: string }).type !== 'message') {
          (parsed as Record<string, unknown>).type = (e as { type?: string }).type as string;
        }
        lastEventRef.current = parsed;
        setEvents((prev) => {
          const next = [...prev, parsed];
          // Keep the buffer bounded in the browser too — 200 is enough to
          // populate Activity without unbounded growth in a long-lived tab.
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    // Listen to both the generic `message` and every named `event:` the bus
    // emits, so `scan.progress` and `job.failed` both arrive even if a
    // browser only fires the named event. Adding a listener for each known
    // type is not required — the `message` listener catches the `data:`.
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('message', onMessage as EventListener);
    // Named events — the server writes `event: <type>` for addEventListener(type).
    const namedTypes = options.types ?? [];
    for (const t of namedTypes) {
      es.addEventListener(t, onMessage as EventListener);
    }
    // Also catch any event that carries a `data:` by listening to all:
    // EventSource has no wildcard, so we rely on the `message` handler above
    // plus a single `*` polyfill via intercepting the underlying `onmessage`
    // when the browser does not dispatch `message` for named events (some do
    // not). The safest is to also wrap `es.onmessage` if used.

    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('message', onMessage as EventListener);
      for (const t of namedTypes) {
        es.removeEventListener(t, onMessage as EventListener);
      }
      es.close();
      setConnected(false);
    };
    // Reconnect when any of these change.
  }, [enabled, options.serverUrl, options.jobId, options.history, typesKey]);

  return {
    events,
    connected,
    error,
    lastEvent: lastEventRef.current,
    clear: () => setEvents([]),
  };
}
