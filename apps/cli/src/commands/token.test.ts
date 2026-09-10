// local-first Phase 5 — `netpro token`.
//
// The token exists for exactly one reason: a server that is reachable from
// somewhere other than this machine. These tests pin the properties that make
// it usable and safe: created once, rotated deliberately, mode 0600, and never
// rendered in full by anything except the command whose job that is.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToken, formatToken } from './token';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-token-'));
  dirs.push(dir);
  return { NETPRO_HOME: dir } as NodeJS.ProcessEnv;
}

describe('netpro token', () => {
  it('creates a token on first use, then returns the same one', async () => {
    const env = scratchEnv();
    const first = await executeToken({}, { env });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^np_[A-Za-z0-9_-]{43}$/);
    expect(first.path).toBe(join(env.NETPRO_HOME!, 'keys', 'access-token'));
    expect(first.preview).toMatch(/^np_.*…/);

    const second = await executeToken({}, { env });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('stores the token with mode 0600 and a trailing newline only', async () => {
    const env = scratchEnv();
    const result = await executeToken({}, { env });
    const raw = readFileSync(result.path, 'utf8');
    expect(raw).toBe(`${result.token}\n`);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('rotates only when asked, and never returns the retired token', async () => {
    const env = scratchEnv();
    const original = await executeToken({}, { env });
    const rotated = await executeToken({ rotate: true }, { env });

    expect(rotated.rotated).toBe(true);
    expect(rotated.token).not.toBe(original.token);
    expect(readFileSync(rotated.path, 'utf8').trim()).toBe(rotated.token);
  });

  it('reports a rotation on a fresh install as a creation, not a rotation', async () => {
    const env = scratchEnv();
    const result = await executeToken({ rotate: true }, { env });
    expect(result.created).toBe(true);
    expect(result.rotated).toBe(false);
  });

  it('--path prints the location and nothing else', async () => {
    const env = scratchEnv();
    const result = await executeToken({}, { env });
    expect(formatToken(result, { path: true })).toBe(result.path);
  });

  it('the human output shows the token but only a preview in the example', async () => {
    const env = scratchEnv();
    const result = await executeToken({}, { env });
    const text = formatToken(result);
    expect(text).toContain(result.token);
    expect(text).toContain(result.preview);
    expect(text).toMatch(/loopback requests .* are trusted/i);
    expect(text).toMatch(/netpro token --rotate/);
  });
});
