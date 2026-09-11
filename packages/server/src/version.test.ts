// The server reports its version in two user-visible places — the built-in
// console page (`GET /`) and `GET /api/settings` — from one literal in
// `version.ts`, because neither route can read the manifest it was released
// from (the server is bundled by tsup, and in the Docker image it runs from
// /app next to no package.json of its own).
//
// That literal is the only thing standing between a version bump and a server
// that introduces itself as the previous release, so it is pinned to the root
// package.json here, the same way apps/cli/src/cli.test.ts pins the CLI's.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from './version';

const packagedVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('the version the server reports', () => {
  it('matches the version the package ships', () => {
    expect(SERVER_VERSION).toBe(packagedVersion);
  });
});
