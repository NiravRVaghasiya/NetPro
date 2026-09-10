import { describe, expect, it } from 'vitest';
import { createJobRegistry, type Job } from './jobs/index';

describe('JobRegistry', () => {
  it('stores and lists jobs', () => {
    const registry = createJobRegistry();
    const job: Job = {
      id: 'j1',
      type: 'import',
      status: 'queued',
      progress: 0,
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: { source: 'linkedin.csv' },
    };
    registry.put(job);
    expect(registry.get('j1')).toEqual(job);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('missing')).toBeUndefined();
  });
});
