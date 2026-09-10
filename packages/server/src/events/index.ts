// packages/server/src/events/index.ts
//
// Phase 1 scaffold for SSE event streaming (full transport in Phase 8).
// The server owns the event bus; core emits domain facts, the UI observes.

import { EventEmitter } from 'node:events';

export type NetProEvent = {
  type: string;
  jobId?: string;
  progress?: number;
  message?: string;
  [key: string]: unknown;
};

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Avoid MaxListenersExceededWarning once many SSE clients subscribe.
    this.emitter.setMaxListeners(100);
  }

  publish(event: NetProEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: NetProEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
