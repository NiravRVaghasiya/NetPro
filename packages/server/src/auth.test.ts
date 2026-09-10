// Phase 5 — the authentication decision, tested as a pure function.
//
// These are the security-relevant rules of the local-first model:
// loopback trust (and its limits), the optional access token, and the modes
// that make remote exposure an explicit, visible choice.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInstallationIdentity } from '@netpro/db';
import {
  authStartupDiagnostics,
  describeAuthPolicy,
  extractCredential,
  isDirectLoopbackRequest,
  isLoopbackAddress,
  loadAuthPolicy,
  resolveAuthContext,
  resolveAuthMode,
  tokensEqual,
  type AuthPolicy,
} from './index';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchHome(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-auth-'));
  dirs.push(dir);
  return { NETPRO_HOME: dir } as NodeJS.ProcessEnv;
}

const LOCAL_LOOPBACK = { remoteAddress: '127.0.0.1', headers: {} };

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'accepts %s',
    (address) => expect(isLoopbackAddress(address)).toBe(true)
  );

  it.each(['192.168.1.10', '10.0.0.1', '::ffff:c0a8:101', 'example.com', '', '   '])(
    'rejects %s',
    (address) => expect(isLoopbackAddress(address)).toBe(false)
  );

  it('rejects a missing address', () => {
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('isDirectLoopbackRequest', () => {
  it('trusts a loopback socket with no proxy headers', () => {
    expect(isDirectLoopbackRequest(LOCAL_LOOPBACK)).toBe(true);
  });

  it.each(['x-forwarded-for', 'x-real-ip', 'forwarded'])(
    'withholds trust when %s is present (a proxy connects from loopback too)',
    (header) => {
      expect(
        isDirectLoopbackRequest({
          remoteAddress: '127.0.0.1',
          headers: { [header]: '203.0.113.7' },
        })
      ).toBe(false);
    }
  );

  it('does not trust a non-loopback peer', () => {
    expect(isDirectLoopbackRequest({ remoteAddress: '192.168.1.10', headers: {} })).toBe(false);
  });
});

describe('extractCredential', () => {
  it('reads a bearer token, case-insensitively', () => {
    expect(extractCredential({ headers: { authorization: 'Bearer np_abc' } })).toBe('np_abc');
    expect(extractCredential({ headers: { authorization: 'bearer   np_abc ' } })).toBe('np_abc');
  });

  it('reads X-NetPro-Token and ?token= (EventSource cannot set headers)', () => {
    expect(extractCredential({ headers: { 'x-netpro-token': 'np_abc' } })).toBe('np_abc');
    expect(extractCredential({ url: '/api/events?token=np_abc' })).toBe('np_abc');
  });

  it('returns null when nothing usable is present', () => {
    expect(extractCredential({})).toBeNull();
    expect(extractCredential({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(extractCredential({ url: '/' })).toBeNull();
  });
});

describe('tokensEqual', () => {
  it('matches identical tokens and rejects everything else', () => {
    expect(tokensEqual('np_abc', 'np_abc')).toBe(true);
    expect(tokensEqual('np_abc', 'np_abd')).toBe(false);
    expect(tokensEqual('np_abc', 'np_abc-longer')).toBe(false);
    expect(tokensEqual('np_abc', null)).toBe(false);
    expect(tokensEqual('', '')).toBe(false);
  });
});

function policy(overrides: Partial<AuthPolicy> = {}): AuthPolicy {
  return {
    mode: 'local',
    token: 'np_local_token',
    installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
    ...overrides,
  };
}

describe('resolveAuthContext', () => {
  it('trusts a direct loopback request in local mode — no login required', () => {
    const ctx = resolveAuthContext(LOCAL_LOOPBACK, policy());
    expect(ctx).toMatchObject({
      mode: 'local',
      authenticated: true,
      trustedLocal: true,
      kind: 'loopback',
      installationId: 'ins_test',
    });
    expect(ctx.reason).toBeUndefined();
  });

  it('denies a remote request with no credential in local mode', () => {
    const ctx = resolveAuthContext(
      { remoteAddress: '203.0.113.7', headers: {} },
      policy()
    );
    expect(ctx).toMatchObject({ authenticated: false, trustedLocal: false, kind: 'anonymous' });
    expect(ctx.reason).toBe('missing-credentials');
  });

  it('accepts the local access token for a remote caller', () => {
    const ctx = resolveAuthContext(
      { remoteAddress: '203.0.113.7', headers: { authorization: 'Bearer np_local_token' } },
      policy()
    );
    expect(ctx).toMatchObject({ authenticated: true, trustedLocal: true, kind: 'token' });
  });

  it('distinguishes a wrong token from a missing one', () => {
    expect(
      resolveAuthContext(
        { remoteAddress: '203.0.113.7', headers: { authorization: 'Bearer nope' } },
        policy()
      ).reason
    ).toBe('invalid-credentials');
  });

  it('denies remote callers when no token exists yet (loopback only)', () => {
    const ctx = resolveAuthContext(
      { remoteAddress: '203.0.113.7', headers: {} },
      policy({ token: null })
    );
    expect(ctx.authenticated).toBe(false);
  });

  it('requires the token even on loopback in token mode', () => {
    const anonymous = resolveAuthContext(LOCAL_LOOPBACK, policy({ mode: 'token' }));
    expect(anonymous).toMatchObject({ authenticated: false, reason: 'missing-credentials' });

    const withToken = resolveAuthContext(
      { remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer np_local_token' } },
      policy({ mode: 'token' })
    );
    expect(withToken.authenticated).toBe(true);
  });

  it('authenticates everyone in open mode but never calls them trusted', () => {
    const ctx = resolveAuthContext({}, policy({ mode: 'open' }));
    expect(ctx).toMatchObject({ authenticated: true, trustedLocal: false, kind: 'open' });
  });

  it('treats a proxied request as remote, even in local mode', () => {
    const ctx = resolveAuthContext(
      { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } },
      policy()
    );
    expect(ctx.authenticated).toBe(false);
  });
});

describe('resolveAuthMode', () => {
  it('defaults to local', () => {
    expect(resolveAuthMode(scratchHome())).toBe('local');
  });

  it('reads [auth] mode from config.toml, with env taking precedence', () => {
    const env = scratchHome();
    writeFileSync(join(env.NETPRO_HOME!, 'config.toml'), '[auth]\nmode = "token"\n');
    expect(resolveAuthMode(env)).toBe('token');
    expect(resolveAuthMode({ ...env, NETPRO_AUTH_MODE: 'open' })).toBe('open');
  });

  it('throws on an unknown mode rather than picking one', () => {
    expect(() => resolveAuthMode({ NETPRO_AUTH_MODE: 'public' } as NodeJS.ProcessEnv)).toThrow(
      /Unknown auth mode/
    );
  });
});

describe('loadAuthPolicy', () => {
  it('resolves the token from NETPRO_AUTH_TOKEN and the identity from disk', () => {
    const env = scratchHome();
    writeInstallationIdentity(
      { id: 'ins_from_disk', createdAt: '2026-09-10T00:00:00.000Z', owner: 'Alex' },
      env
    );
    const loaded = loadAuthPolicy({ ...env, NETPRO_AUTH_TOKEN: 'np_from_env' });
    expect(loaded.token).toBe('np_from_env');
    expect(loaded.installation).toMatchObject({ id: 'ins_from_disk', owner: 'Alex' });
    expect(loaded.mode).toBe('local');
  });

  it('has no token and no identity on a fresh install — and that is not an error', () => {
    const loaded = loadAuthPolicy(scratchHome());
    expect(loaded.token).toBeNull();
    expect(loaded.installation).toBeNull();
  });
});

describe('authStartupDiagnostics', () => {
  it('says nothing on the local-first default', () => {
    expect(
      authStartupDiagnostics(policy({ token: null }), { host: '127.0.0.1', isLoopbackHost: true })
    ).toEqual([]);
  });

  it('refuses token mode without a token', () => {
    const diagnostics = authStartupDiagnostics(policy({ mode: 'token', token: null }), {
      host: '127.0.0.1',
      isLoopbackHost: true,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.level).toBe('error');
    expect(diagnostics[0]!.message).toMatch(/netpro token --rotate/);
  });

  it('warns when a remote bind would deny every caller, and again once a token exists', () => {
    const without = authStartupDiagnostics(policy({ token: null }), {
      host: '0.0.0.0',
      isLoopbackHost: false,
    });
    expect(without[0]!.level).toBe('warning');
    expect(without[0]!.message).toMatch(/401/);

    const withToken = authStartupDiagnostics(policy(), { host: '0.0.0.0', isLoopbackHost: false });
    expect(withToken[0]!.level).toBe('warning');
    expect(withToken[0]!.message).toMatch(/access token/);
  });

  it('warns loudly that open mode answers anyone', () => {
    const diagnostics = authStartupDiagnostics(policy({ mode: 'open', token: null }), {
      host: '0.0.0.0',
      isLoopbackHost: false,
    });
    expect(diagnostics.some((d) => /answers anyone/.test(d.message))).toBe(true);
  });
});

describe('describeAuthPolicy', () => {
  it('describes each mode in one line', () => {
    expect(describeAuthPolicy(policy())).toMatch(/local — loopback trusted/);
    expect(describeAuthPolicy(policy({ mode: 'token', token: null }))).toMatch(/token required/);
    expect(describeAuthPolicy(policy({ mode: 'open' }))).toMatch(/no authentication/);
  });
});
