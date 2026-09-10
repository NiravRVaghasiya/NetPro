// packages/server/src/events/index.ts
//
// Phase 8 scaffold + Phase 7 wiring — the server owns the event bus,
// core emits domain facts, the UI observes via SSE (`GET /api/events`).
//
// The bus is synchronous and in-process today; the interface is preserved
// when persistence or a fan-out worker arrives. Every job transition and
// every long-running core call publishes through here, so a CLI-triggered
// `netpro scan` shows up in the Web UI without polling.

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
};

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients may subscribe simultaneously.
    this.emitter.setMaxListeners(100);
  }

  publish(event: NetProEvent): void {
    const withTs: NetProEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.emitter.emit('event', withTs);
  }

  subscribe(listener: (event: NetProEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  /** Active subscriber count — useful for health/debug. */
  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
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
  'job.failed',
] as const;
