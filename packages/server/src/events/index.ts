// packages/server/src/events/index.ts
//
// Phase 8 — event streaming (SSE).
//
// The server owns the event bus, core emits domain facts, the UI observes via
// SSE (`GET /api/events`). The bus is synchronous and in-process today; the
// interface is preserved when persistence or a fan-out worker arrives. Every
// job transition and every long-running core call publishes through here, so a
// CLI-triggered `netpro scan` shows up in the Web UI without polling.
//
// Phase 8 adds:
//  - a bounded replay buffer (last 200 events) so a late-joining EventSource
//    sees recent history immediately instead of a blank stream,
//  - filtered subscriptions (`type` / `jobId`), and
//  - a canonical `EVENT_TYPES` set the UI can filter without stringly guessing.
//
// The buffer is in-memory and per-process — sufficient for the local-first
// server where the bus and its consumers share a process. A future persistent
// fan-out worker will replace the store without changing the transport.

import { EventEmitter } from 'node:events';

export type NetProEvent = {
  type: string;
  jobId?: string;
  progress?: number;
  message?: string;
  /** Free-form payload — callers must not trust a shape beyond `type`. */
  [key: string]: unknown;
  /** Server timestamp when the bus published this event. */
  timestamp?: string;
  /** Monotonic per-bus sequence, useful for Last-Event-ID / replay. */
  seq?: number;
};

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: NetProEvent[] = [];
  private seq = 0;
  private readonly maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 200;
    // Many SSE clients may subscribe simultaneously.
    this.emitter.setMaxListeners(200);
  }

  publish(event: NetProEvent): NetProEvent {
    this.seq += 1;
    const now = new Date().toISOString();
    const withMeta: NetProEvent = {
      ...event,
      timestamp: event.timestamp ?? now,
      seq: event.seq ?? this.seq,
    };
    // Authority: the bus owns timestamp/seq — but we respect an explicit
    // caller timestamp for replayed / synthetic events. Always ensure seq is the bus's.
    withMeta.seq = this.seq;
    if (!event.timestamp) withMeta.timestamp = now;

    // Bounded buffer — oldest evicted.
    this.history.push(withMeta);
    if (this.history.length > this.maxHistory) this.history.shift();

    this.emitter.emit('event', withMeta);
    return withMeta;
  }

  subscribe(listener: (event: NetProEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  /**
   * Subscribe only to events that match the filter. The predicate runs
   * synchronously on the emit path, so it should stay cheap.
   */
  subscribeFiltered(
    filter: { type?: string | string[]; jobId?: string },
    listener: (event: NetProEvent) => void
  ): () => void {
    const types = filter.type
      ? Array.isArray(filter.type)
        ? new Set(filter.type)
        : new Set([filter.type])
      : null;
    const jobId = filter.jobId ?? null;
    const wrapped = (event: NetProEvent): void => {
      if (types && !types.has(event.type)) return;
      if (jobId && event.jobId !== jobId) return;
      listener(event);
    };
    return this.subscribe(wrapped);
  }

  /** Active subscriber count — useful for health/debug. */
  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }

  /** Snapshot of recent events, newest last (oldest first). */
  getHistory(limit?: number): NetProEvent[] {
    if (limit === undefined || limit >= this.history.length) return [...this.history];
    if (limit <= 0) return [];
    return this.history.slice(-limit);
  }

  /** Number of buffered events. */
  historySize(): number {
    return this.history.length;
  }

  /** Clear the buffer (tests / retention). */
  clearHistory(): void {
    this.history.length = 0;
  }

  /** Last sequence number emitted (0 before any publish). */
  lastSeq(): number {
    return this.seq;
  }
}

export function createEventBus(options?: { maxHistory?: number }): EventBus {
  return new EventBus(options);
}

/** Canonical event names — the UI can filter without stringly guessing. */
export const EVENT_TYPES = [
  'job.queued',
  'job.running',
  'job.progress',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'scan.started',
  'scan.progress',
  'scan.completed',
  'contact.imported',
  'contact.updated',
  'relationship.discovered',
  'relationship.updated',
  'graph.updated',
  'search.started',
  'search.completed',
  'enrichment.started',
  'enrichment.completed',
  'import.started',
  'import.progress',
  'import.completed',
] as const;

export type NetProEventType = (typeof EVENT_TYPES)[number];

export function isNetProEventType(value: string): value is NetProEventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
