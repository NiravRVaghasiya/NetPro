import { describe, expect, it } from 'vitest';
import {
  VIEWER_HASH_HEX_LENGTH,
  dailyViewSalt,
  hashViewerFingerprint,
  hashViewerIp,
  isViewerHash,
  utcDayIso,
} from './privacy';

const BASE_SALT = 'netpro-test-salt';
const DAY = new Date('2026-09-08T10:00:00.000Z');
const NEXT_DAY = new Date('2026-09-09T10:00:00.000Z');
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

describe('profile view privacy hashing (v2.5 phase 1)', () => {
  it('hashes the same (ip, UA, salt, day) deterministically into 16 hex chars', () => {
    const first = hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY });
    const second = hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY });
    expect(first).toBe(second);
    expect(first).toHaveLength(VIEWER_HASH_HEX_LENGTH);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // The raw IP never appears in — or survives as — the stored value.
    expect(first).not.toContain(IP);
    expect(isViewerHash(first)).toBe(true);
  });

  it('changes when the salt changes (different deployments or rotated secrets)', () => {
    expect(hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY })).not.toBe(
      hashViewerIp({ ip: IP, userAgent: UA, baseSalt: 'another-salt', date: DAY }),
    );
    expect(dailyViewSalt(BASE_SALT, DAY)).not.toBe(dailyViewSalt('another-salt', DAY));
  });

  it('rotates daily, so hashes cannot be correlated across days', () => {
    expect(dailyViewSalt(BASE_SALT, DAY)).not.toBe(dailyViewSalt(BASE_SALT, NEXT_DAY));
    expect(hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY })).not.toBe(
      hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: NEXT_DAY }),
    );
  });

  it('binds the user agent, so a shared IP does not collapse different viewers', () => {
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; rv:126.0) Gecko/20100101 Firefox/126.0';
    expect(hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY })).not.toBe(
      hashViewerIp({ ip: IP, userAgent: firefox, baseSalt: BASE_SALT, date: DAY }),
    );
    // And a missing UA is a stable input, not an error.
    expect(hashViewerIp({ ip: IP, userAgent: null, baseSalt: BASE_SALT, date: DAY })).toBe(
      hashViewerIp({ ip: IP, userAgent: undefined, baseSalt: BASE_SALT, date: DAY }),
    );
  });

  it('fingerprints a 24h dedup value that differs from the IP hash', () => {
    const fp = hashViewerFingerprint({
      ip: IP,
      userAgent: UA,
      acceptLanguage: 'en-US,en;q=0.9',
      baseSalt: BASE_SALT,
      date: DAY,
    });
    expect(fp).toHaveLength(VIEWER_HASH_HEX_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toBe(hashViewerIp({ ip: IP, userAgent: UA, baseSalt: BASE_SALT, date: DAY }));
    // Accept-language participates: same ip/UA, different languages differ.
    expect(fp).not.toBe(
      hashViewerFingerprint({
        ip: IP,
        userAgent: UA,
        acceptLanguage: 'de-DE,de;q=0.9',
        baseSalt: BASE_SALT,
        date: DAY,
      }),
    );
    expect(
      hashViewerFingerprint({
        ip: IP,
        userAgent: UA,
        acceptLanguage: 'en-US,en;q=0.9',
        baseSalt: BASE_SALT,
        date: DAY,
      }),
    ).toBe(fp);
  });

  it('only ever accepts 16 lowercase hex chars as a stored hash', () => {
    expect(isViewerHash('a1b2c3d4e5f60718')).toBe(true);
    expect(isViewerHash('A1B2C3D4E5F60718')).toBe(false); // uppercase
    expect(isViewerHash('a1b2c3d4e5f6071')).toBe(false); // too short
    expect(isViewerHash('a1b2c3d4e5f60718ff')).toBe(false); // too long
    expect(isViewerHash('203.0.113.7')).toBe(false); // raw IP
    expect(isViewerHash('xyz-not-a-hash')).toBe(false);
    expect(isViewerHash(null)).toBe(false);
    expect(isViewerHash(undefined)).toBe(false);
  });

  it('computes the UTC day string used for salt rotation', () => {
    expect(utcDayIso(DAY)).toBe('2026-09-08');
    expect(utcDayIso(new Date('2026-12-31T23:59:59.000Z'))).toBe('2026-12-31');
    expect(utcDayIso(new Date('2026-12-31T23:59:59.000-05:00'))).toBe('2027-01-01');
  });
});
