import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeConfig } from './config';

describe('executeConfig', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'netpro-config-test-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('round-trips set and get', async () => {
    const setOutput = await executeConfig({ action: 'set', key: 'enrichment.hunter', value: 'abc123' });
    expect(setOutput).toBe('✓ Set enrichment.hunter');
    expect(await executeConfig({ action: 'get', key: 'enrichment.hunter' })).toBe('abc123');
  });

  it('reports not set for a missing key', async () => {
    expect(await executeConfig({ action: 'get', key: 'enrichment.pdl' })).toBe('enrichment.pdl: not set');
  });

  it('lists configured keys', async () => {
    await executeConfig({ action: 'set', key: 'enrichment.hunter', value: 'a' });
    await executeConfig({ action: 'set', key: 'enrichment.clearbit', value: 'b' });
    const list = await executeConfig({ action: 'list' });
    expect(list).toContain('enrichment.hunter');
    expect(list).toContain('enrichment.clearbit');
  });

  it('deletes a stored key', async () => {
    await executeConfig({ action: 'set', key: 'enrichment.pdl', value: 'x' });
    expect(await executeConfig({ action: 'delete', key: 'enrichment.pdl' })).toBe('✓ Deleted enrichment.pdl');
    expect(await executeConfig({ action: 'get', key: 'enrichment.pdl' })).toBe('enrichment.pdl: not set');
  });
});
