// local-first Phase 5 — installation identity and local access token.
//
// The identity is written once and never rewritten behind the user's back;
// the token is the only credential the local server ever accepts. Both live in
// `~/.netpro` and both must survive being read by hand and edited by hand.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessTokenPath,
  ensureAccessToken,
  ensureInstallationIdentity,
  generateAccessToken,
  generateInstallationId,
  readAccessToken,
  readInstallationIdentity,
  redactAccessToken,
  resolveAccessToken,
  upsertInstallationSection,
  writeAccessToken,
  writeInstallationIdentity,
} from './identity';
import { readLocalConfig } from './local';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-identity-'));
  dirs.push(dir);
  return { NETPRO_HOME: dir } as NodeJS.ProcessEnv;
}

describe('installation identity', () => {
  it('generates self-describing, unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateInstallationId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^ins_[0-9a-f]{24}$/);
  });

  it('is absent on a fresh install and is never invented by a read', () => {
    const env = scratchEnv();
    expect(readInstallationIdentity(env)).toBeNull();
    expect(existsSync(join(env.NETPRO_HOME!, 'config.toml'))).toBe(false);
  });

  it('mints once, persists to config.toml, and reuses the same identity', () => {
    const env = scratchEnv();
    const first = ensureInstallationIdentity(env, {
      owner: 'Alex',
      email: 'alex@example.com',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });
    expect(first.created).toBe(true);
    expect(first.identity.createdAt).toBe('2026-09-10T12:00:00.000Z');

    // Round-trips through the same reader the CLI and server use.
    const parsed = readInstallationIdentity(env);
    expect(parsed).toEqual(first.identity);
    const config = readLocalConfig(env);
    expect(config.installation?.id).toBe(first.identity.id);

    // A second call — even asking for a different owner — never rewrites it.
    const second = ensureInstallationIdentity(env, { owner: 'Someone Else' });
    expect(second.created).toBe(false);
    expect(second.identity).toEqual(first.identity);
    expect(readInstallationIdentity(env)?.owner).toBe('Alex');
  });

  it('fills in the section of an existing config without touching anything else', () => {
    const env = scratchEnv();
    const original = [
      '# NetPro configuration',
      '',
      '[database]',
      '# dialect = "sqlite"',
      '',
      '[installation]',
      '# owner = "Your name"',
      '',
      '[server]',
      '# port = 3777',
      '',
    ].join('\n');
    writeFileSync(join(env.NETPRO_HOME!, 'config.toml'), original);
    ensureInstallationIdentity(env, { id: 'ins_fixed', now: new Date('2026-01-02T00:00:00.000Z') });

    const written = readFileSync(join(env.NETPRO_HOME!, 'config.toml'), 'utf8');
    expect(written).toContain('id = "ins_fixed"');
    expect(written).toContain('created_at = "2026-01-02T00:00:00.000Z"');
    // Every line the user (or a previous version) wrote is still there.
    for (const line of original.split('\n')) {
      if (line === '' || line.startsWith('# owner')) continue;
      expect(written).toContain(line);
    }
    // Still valid TOML for the strict parser.
    expect(readLocalConfig(env).installation?.id).toBe('ins_fixed');
  });

  it('keeps hand-written keys and comments (fill in the blanks)', () => {
    const existing = [
      '[installation]',
      'id = "ins_hand_written"',
      '# my note',
      '',
    ].join('\n');
    const merged = upsertInstallationSection(existing, {
      id: 'ins_generated',
      createdAt: '2026-09-10T00:00:00.000Z',
      owner: 'Alex',
    });
    expect(merged).toContain('id = "ins_hand_written"');
    expect(merged).not.toContain('ins_generated');
    expect(merged).toContain('created_at = "2026-09-10T00:00:00.000Z"');
    expect(merged).toContain('owner = "Alex"');
    expect(merged).toContain('# my note');
  });

  it('is a no-op when every key is already present', () => {
    const text = '[installation]\nid = "ins_x"\ncreated_at = "2026-01-01T00:00:00.000Z"\n';
    expect(
      upsertInstallationSection(text, { id: 'ins_other', createdAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(text);
  });

  it('creates the section at the end when the file has none', () => {
    const merged = upsertInstallationSection('[server]\nport = 3777\n', {
      id: 'ins_new',
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    expect(merged.startsWith('[server]\nport = 3777\n')).toBe(true);
    expect(merged).toContain('[installation]\nid = "ins_new"');
  });

  it('escapes strings so a quote in a name cannot corrupt the file', () => {
    const merged = upsertInstallationSection('', {
      id: 'ins_q',
      createdAt: '2026-01-01T00:00:00.000Z',
      owner: 'A "Quoted" Name',
    });
    expect(merged).toContain('owner = "A \\"Quoted\\" Name"');
  });
});

describe('local access token', () => {
  it('lives under <home>/keys/access-token', () => {
    const env = scratchEnv();
    expect(accessTokenPath(env)).toBe(join(env.NETPRO_HOME!, 'keys', 'access-token'));
  });

  it('has no token until one is created, and creation is idempotent', () => {
    const env = scratchEnv();
    expect(readAccessToken(env)).toBeNull();

    const first = ensureAccessToken(env);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^np_[A-Za-z0-9_-]{43}$/);

    const second = ensureAccessToken(env);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('writes mode 0600 and round-trips through readAccessToken', () => {
    const env = scratchEnv();
    const token = generateAccessToken();
    const path = writeAccessToken(token, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${token}\n`);
    expect(readAccessToken(env)).toBe(token);
  });

  it('refuses to write an empty token', () => {
    expect(() => writeAccessToken('  ', scratchEnv())).toThrow(/empty access token/);
  });

  it('prefers NETPRO_AUTH_TOKEN, so a mounted secret needs no writable home', () => {
    const env = scratchEnv();
    writeAccessToken('np_from_file', env);
    expect(resolveAccessToken(env)).toBe('np_from_file');
    expect(resolveAccessToken({ ...env, NETPRO_AUTH_TOKEN: 'np_from_env' })).toBe('np_from_env');
  });

  it('treats an empty file as no token rather than an empty credential', () => {
    const env = scratchEnv();
    writeAccessToken('np_existing', env);
    writeFileSync(accessTokenPath(env), '\n');
    expect(readAccessToken(env)).toBeNull();
  });

  it('redacts for display, keeping enough to identify a token', () => {
    const token = generateAccessToken();
    const preview = redactAccessToken(token);
    expect(preview).toMatch(/^np_.*…/);
    expect(preview).not.toBe(token);
    expect(preview.length).toBeLessThan(token.length);
    expect(redactAccessToken('short')).toBe('****');
  });
});
