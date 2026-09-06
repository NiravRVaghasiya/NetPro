import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards the contract between `tsup.config.ts` and the Dockerfile runner stage.
 *
 * The published image copies `apps/cli/dist` next to a Next.js standalone tree
 * that only contains the web app's own dependencies. Anything tsup leaves as a
 * bare import must therefore be copied into the image explicitly. When the CLI
 * gained `commander` and `drizzle-orm` as externals, nobody updated the
 * Dockerfile and the image failed at runtime, only in CI's docker job:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'commander'
 *     imported from /app/apps/cli/dist/index.js
 *
 * The fix bundles everything except the two modules that genuinely cannot be
 * bundled. This test pins that list so a new dependency can't quietly reopen
 * the same production-only hole.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../dist/index.js');

// better-sqlite3 is a native addon; pg is CommonJS that resolves optional
// backends dynamically. Both must exist in the image's node_modules.
const ALLOWED_EXTERNALS = ['better-sqlite3', 'pg'];

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function externalImports(source: string): string[] {
  const specifiers = new Set<string>();
  // Static `from '...'` plus dynamic `import('...')` at the top level of the
  // emitted ESM bundle. Comment lines are ignored so esbuild's inlined module
  // path banners (`// ../../node_modules/drizzle-orm/pg-core/...`) don't count.
  const patterns = [
    /(?:^|[\s;}])(?:import|export)[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  // Strip comments before scanning. Bundled dependencies carry JSDoc with
  // example `import { union } from 'drizzle-orm/sqlite-core'` lines, and
  // esbuild prefixes each inlined module with a `// path/to/module.js` banner.
  // Neither is a real runtime import, but both match the patterns below.
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (builtins.has(specifier)) continue;
      // Compare on package name so subpaths map to their owning package.
      const parts = specifier.split('/');
      const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      specifiers.add(pkg);
    }
  }

  return [...specifiers].sort();
}

describe('CLI bundle runtime dependencies', () => {
  it.runIf(existsSync(bundlePath))(
    'leaves only the non-bundlable native modules external',
    () => {
      const source = readFileSync(bundlePath, 'utf8');
      expect(externalImports(source)).toEqual(ALLOWED_EXTERNALS);
    },
  );

  it.runIf(existsSync(bundlePath))('ships a require shim for inlined CommonJS deps', () => {
    // commander is CommonJS and calls require('events') internally. Without a
    // createRequire-backed `require` in scope, esbuild's stub throws
    // "Dynamic require of \"events\" is not supported" the moment the CLI runs.
    const source = readFileSync(bundlePath, 'utf8');
    expect(source).toContain('createRequire');
  });

  it('keeps the Dockerfile copying every external module', () => {
    const dockerfile = readFileSync(resolve(here, '../../../Dockerfile'), 'utf8');
    for (const dep of ALLOWED_EXTERNALS) {
      expect(dockerfile).toMatch(new RegExp(`COPY[^\\n]*node_modules/${dep}\\s`));
    }
  });
});
