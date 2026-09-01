import { describe, it, expect } from 'vitest';
import * as core from './index';

describe('@netpro/core module boundaries', () => {
  it('exposes all seven feature modules', () => {
    expect(core.search.MODULE_NAME).toBe('search');
    expect(typeof core.enrichment.EnrichmentPipeline).toBe('function');
    expect(core.analytics.MODULE_NAME).toBe('analytics');
    expect(core.ai.MODULE_NAME).toBe('ai');
    expect(core.crm.MODULE_NAME).toBe('crm');
    expect(typeof core.importPipeline.runImport).toBe('function');
    expect(typeof core.exportPipeline.exportContactsCSV).toBe('function');
  });
});
