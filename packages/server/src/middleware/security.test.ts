import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  applyConsoleCsp,
  applySecurityHeaders,
  CONSOLE_CSP,
  HSTS_HEADER_VALUE,
  isLoopbackOrigin,
  isOriginAllowed,
  parseAllowedOrigins,
  resolveAllowedOrigins,
} from './security';

/** Minimal ServerResponse stand-in: setHeader/getHeader only. */
function stubResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      },
    } as unknown as ServerResponse,
  };
}

describe('security headers (phase 23)', () => {
  it('applies the hardening headers to every response, HSTS only when asked', () => {
    const plain = stubResponse();
    applySecurityHeaders(plain.res);
    expect(plain.headers.get('x-content-type-options')).toBe('nosniff');
    expect(plain.headers.get('x-frame-options')).toBe('DENY');
    expect(plain.headers.get('referrer-policy')).toBe('no-referrer');
    expect(plain.headers.has('strict-transport-security')).toBe(false);

    const tls = stubResponse();
    applySecurityHeaders(tls.res, { hsts: true });
    expect(tls.headers.get('strict-transport-security')).toBe(HSTS_HEADER_VALUE);
  });

  it('gives the console pages a strict self-only CSP', () => {
    const { res, headers } = stubResponse();
    applyConsoleCsp(res);
    const csp = headers.get('content-security-policy') ?? '';
    expect(csp).toBe(CONSOLE_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('http://');
    expect(csp).not.toContain('https://');
  });
});

describe('CORS origin policy (phase 23)', () => {
  it('parses a CSV allow-list and treats blank as unset', () => {
    expect(parseAllowedOrigins(undefined)).toBeNull();
    expect(parseAllowedOrigins('')).toBeNull();
    expect(parseAllowedOrigins('   ')).toBeNull();
    expect(parseAllowedOrigins('https://ui.example.com, https://netpro.example.com')).toEqual([
      'https://ui.example.com',
      'https://netpro.example.com',
    ]);
  });

  it('prefers NETPRO_ALLOWED_ORIGINS over the config-file value', () => {
    expect(resolveAllowedOrigins({} as NodeJS.ProcessEnv, 'https://file.example.com')).toEqual([
      'https://file.example.com',
    ]);
    expect(
      resolveAllowedOrigins({ NETPRO_ALLOWED_ORIGINS: 'https://env.example.com' }, 'https://file.example.com')
    ).toEqual(['https://env.example.com']);
    expect(resolveAllowedOrigins({} as NodeJS.ProcessEnv, undefined)).toBeNull();
  });

  it('recognizes loopback origins in all their disguises', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:3000',
      'http://LOCALHOST:8080',
      'http://127.0.0.1:4000',
      'http://127.0.0.2',
      'http://[::1]:4000',
      'http://[::ffff:127.0.0.1]:4000',
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
    for (const origin of [
      'https://app.netpro.example.com',
      'http://192.168.1.10:4000',
      'http://10.0.0.2',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'not a url',
      '',
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
  });

  it('defaults to loopback-only and matches explicit lists exactly', () => {
    expect(isOriginAllowed('http://localhost:3000', null)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:4000', null)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', null)).toBe(false);

    const list = ['https://ui.example.com'];
    expect(isOriginAllowed('https://ui.example.com', list)).toBe(true);
    // An explicit list replaces the default: loopback must be named too.
    expect(isOriginAllowed('http://localhost:3000', list)).toBe(false);
    // No wildcards, no suffix tricks, no path smuggling.
    expect(isOriginAllowed('https://evil-ui.example.com', list)).toBe(false);
    expect(isOriginAllowed('https://ui.example.com.evil.com', list)).toBe(false);
    expect(isOriginAllowed('https://ui.example.com/', list)).toBe(false);
    expect(isOriginAllowed('*', list)).toBe(false);
  });
});
