import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Keychain (encrypted-file fallback)', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'netpro-keychain-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('round-trips a stored secret', async () => {
    const { Keychain } = await import('./keychain');
    await Keychain.set('test-key', 'super-secret');
    expect(await Keychain.get('test-key')).toBe('super-secret');
  });

  it('returns null for a missing key', async () => {
    const { Keychain } = await import('./keychain');
    expect(await Keychain.get('does-not-exist')).toBeNull();
  });

  it('deletes a stored secret', async () => {
    const { Keychain } = await import('./keychain');
    await Keychain.set('to-delete', 'value');
    await Keychain.delete('to-delete');
    expect(await Keychain.get('to-delete')).toBeNull();
  });
});
