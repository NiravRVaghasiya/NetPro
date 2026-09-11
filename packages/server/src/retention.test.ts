import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeConn, createDb, runMigrations, type SqliteConn } from '@netpro/db';
import {
  retentionConfig,
  retentionDisabled,
  startRetentionSchedule,
} from './retention';

const dirs: string[] = [];
const conns: SqliteConn[] = [];

afterEach(async () => {
  while (conns.length) {
    const c = conns.pop();
    if (c) await closeConn(c).catch(() => {});
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchConn(): { conn: SqliteConn; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-retention-'));
  dirs.push(dir);
  const env: NodeJS.ProcessEnv = { NETPRO_HOME: dir, DB_PATH: join(dir, 'netpro.db') };
  const conn = createDb(env) as SqliteConn;
  conns.push(conn);
  return { conn, env };
}

describe('retentionConfig (Phase 24 server-side purge)', () => {
  it('defaults to the shipped windows', () => {
    const c = retentionConfig({});
    expect(c.enabled).toBe(true);
    expect(c.viewRetentionDays).toBe(90);
    expect(c.contentMetricRetentionDays).toBe(365);
    expect(c.webhookDeliveryRetentionDays).toBe(30);
  });

  it('NETPRO_DISABLE_RETENTION=true disables the schedule', () => {
    expect(retentionDisabled({ NETPRO_DISABLE_RETENTION: 'true' })).toBe(true);
    expect(retentionDisabled({ NETPRO_DISABLE_RETENTION: 'TRUE' })).toBe(true);
    expect(retentionDisabled({})).toBe(false);
    expect(retentionConfig({ NETPRO_DISABLE_RETENTION: 'true' }).enabled).toBe(false);
  });

  it('garbage or empty day counts fall back to the defaults, valid ones pass through', () => {
    const c = retentionConfig({
      NETPRO_VIEW_RETENTION_DAYS: 'oops',
      NETPRO_CONTENT_METRIC_RETENTION_DAYS: '0',
      NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS: '31',
    });
    expect(c.viewRetentionDays).toBe(90);
    expect(c.contentMetricRetentionDays).toBe(365);
    expect(c.webhookDeliveryRetentionDays).toBe(31);
  });
});

describe('startRetentionSchedule', () => {
  it('does not start when retention is disabled', async () => {
    const { conn, env } = scratchConn();
    await runMigrations(conn);
    const schedule = startRetentionSchedule(conn, { ...env, NETPRO_DISABLE_RETENTION: 'true' });
    expect(schedule).toBeNull();
  });

  it('runs one purge at start; a second start within 24 h is skipped by the guard', async () => {
    const { conn, env } = scratchConn();
    await runMigrations(conn);

    const lines: string[] = [];
    const first = startRetentionSchedule(conn, env, (line) => lines.push(line));
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    first!.stop();
    expect(lines.some((line) => line.includes('retention purge: deleted'))).toBe(true);

    // The core guard reads the audit row the first run wrote, so an immediate
    // second schedule must not delete/log again.
    const secondLines: string[] = [];
    const second = startRetentionSchedule(conn, env, (line) => secondLines.push(line));
    await new Promise((resolve) => setTimeout(resolve, 60));
    second!.stop();
    expect(secondLines.some((line) => line.includes('retention purge: deleted'))).toBe(false);
  });
});
