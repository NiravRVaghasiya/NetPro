import { describe, it, expect } from 'vitest';
import * as core from './index';

describe('@netpro/core module boundaries', () => {
  it('exposes all seven feature modules', () => {
    expect(core.search.MODULE_NAME).toBe('search');
    expect(core.enrichment.MODULE_NAME).toBe('enrichment');
    expect(core.analytics.MODULE_NAME).toBe('analytics');
    expect(core.ai.MODULE_NAME).toBe('ai');
    expect(core.crm.MODULE_NAME).toBe('crm');
    expect(core.importPipeline.MODULE_NAME).toBe('import');
    expect(core.exportPipeline.MODULE_NAME).toBe('export');
  });
});
