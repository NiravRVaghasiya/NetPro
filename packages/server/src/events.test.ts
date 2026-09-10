import { describe, expect, it } from 'vitest';
import { createEventBus } from './events/index';

describe('EventBus', () => {
  it('publishes events to subscribers and supports unsubscribe', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const stop = bus.subscribe((e) => seen.push(e.type));

    bus.publish({ type: 'scan.started', jobId: 'a' });
    bus.publish({ type: 'scan.progress', jobId: 'a', progress: 10 });
    stop();
    bus.publish({ type: 'scan.completed', jobId: 'a' });

    expect(seen).toEqual(['scan.started', 'scan.progress']);
  });

  it('delivers the same event to every active subscriber', () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((e) => a.push(e.type));
    bus.subscribe((e) => b.push(e.type));
    bus.publish({ type: 'graph.updated' });
    expect(a).toEqual(['graph.updated']);
    expect(b).toEqual(['graph.updated']);
  });
});
