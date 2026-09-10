// packages/core/src/plugins/manifest.test.ts
// v3.0 Phase 5 — manifest validation tests

import { describe, expect, it } from 'vitest';
import { validateManifest, satisfiesEngineRange } from './manifest';

describe('plugin manifest validation (Phase 5)', () => {
  const base = {
    name: 'example-plugin',
    version: '1.0.0',
    engine: '^3.0.0',
    permissions: { capabilities: ['event-discovery'] as const },
  };

  it('accepts a minimal valid manifest', () => {
    expect(() => validateManifest(base)).not.toThrow();
  });

  it('rejects malformed manifests', () => {
    expect(() => validateManifest(null)).toThrow(/object/);
    expect(() => validateManifest({})).toThrow();
    expect(() => validateManifest({ ...base, name: '' })).toThrow(/name/);
    expect(() => validateManifest({ ...base, name: '.hidden' })).toThrow();
    expect(() => validateManifest({ ...base, name: 'UPPERCASE' })).toThrow();
  });

  it('rejects bad semver', () => {
    expect(() => validateManifest({ ...base, version: '1' })).toThrow(/version/);
    expect(() => validateManifest({ ...base, version: 'v1.0.0' })).toThrow(/version/);
    expect(() => validateManifest({ ...base, version: '1.0' })).toThrow();
  });

  it('rejects invalid engine range', () => {
    expect(() => validateManifest({ ...base, engine: '' })).toThrow(/Engine/);
    expect(() => validateManifest({ ...base, engine: 'not-a-range' })).toThrow(/engine range/i);
  });

  it('rejects unknown capabilities', () => {
    expect(() =>
      validateManifest({ ...base, permissions: { capabilities: ['unknown-cap' as never] } })
    ).toThrow(/Unknown capability/);
  });

  it('rejects oversized settings specs', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, type: 'string' as const }));
    expect(() => validateManifest({ ...base, settings: many as never })).toThrow(/Too many settings/);
  });

  it('rejects duplicate setting keys', () => {
    expect(() =>
      validateManifest({
        ...base,
        settings: [
          { key: 'foo', label: 'Foo', type: 'string' as const },
          { key: 'foo', label: 'Foo2', type: 'string' as const },
        ],
      })
    ).toThrow(/Duplicate setting key/);
  });

  it('rejects invalid network hosts', () => {
    expect(() =>
      validateManifest({ ...base, permissions: { capabilities: ['event-discovery'], network: ['not a host'] } })
    ).toThrow(/Invalid network host/);
    expect(() =>
      validateManifest({ ...base, permissions: { capabilities: ['event-discovery'], network: ['*api.example.com'] } })
    ).toThrow(/Wildcard/);
  });

  it('rejects entry path traversal', () => {
    expect(() => validateManifest({ ...base, entry: '../evil.js' })).toThrow(/relative path/);
    expect(() => validateManifest({ ...base, entry: '/etc/passwd' })).toThrow();
  });

  it('accepts wildcard network hosts', () => {
    expect(() =>
      validateManifest({
        ...base,
        permissions: { capabilities: ['event-discovery'], network: ['*.example.com', 'api.example.com'] },
      })
    ).not.toThrow();
  });
});

describe('engine range satisfaction (Phase 5)', () => {
  it('handles ^ ranges', () => {
    expect(satisfiesEngineRange('3.0.0', '^3.0.0')).toBe(true);
    expect(satisfiesEngineRange('3.1.0', '^3.0.0')).toBe(true);
    expect(satisfiesEngineRange('4.0.0', '^3.0.0')).toBe(false);
    expect(satisfiesEngineRange('2.9.9', '^3.0.0')).toBe(false);
  });

  it('handles ~ ranges', () => {
    expect(satisfiesEngineRange('3.0.1', '~3.0.0')).toBe(true);
    expect(satisfiesEngineRange('3.1.0', '~3.0.0')).toBe(false);
  });

  it('handles >= and exact', () => {
    expect(satisfiesEngineRange('3.0.0', '>=3.0.0')).toBe(true);
    expect(satisfiesEngineRange('3.0.0', '3.0.0')).toBe(true);
    expect(satisfiesEngineRange('3.0.1', '3.0.0')).toBe(false);
  });

  it('handles OR groups', () => {
    expect(satisfiesEngineRange('4.0.0', '^3.0.0 || ^4.0.0')).toBe(true);
    expect(satisfiesEngineRange('3.5.0', '^3.0.0 || ^4.0.0')).toBe(true);
    expect(satisfiesEngineRange('2.0.0', '^3.0.0 || ^4.0.0')).toBe(false);
  });
});
