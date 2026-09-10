// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations } from '@netpro/db';
import { createApp } from './app';
import { startServer } from './server';
import type { AuthPolicy } from './auth/index';
import { runImport } from '@netpro/core/src/import';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-phase67-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_PATH = path;
  const conn = createDb();
  return { conn, path, dir };
}

const LOCAL_POLICY: AuthPolicy = {
  mode: 'local',
  token: null,
  installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
};

describe('Phase 6 Web API', () => {
  it('GET /api/contacts returns paginated CRM list', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    // seed two contacts
    conn.db.insert(conn.schema.contacts).values({
      id: 'c1',
      fullName: 'Jane Doe',
      company: 'Stripe',
      role: 'Engineer',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    conn.db.insert(conn.schema.contacts).values({
      id: 'c2',
      fullName: 'John Smith',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/contacts`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.total).toBe(2);
      expect(body.contacts).toHaveLength(2);
      expect(body.contacts[0].id).toBeDefined();
      // contacts/:id
      const one = await fetch(`${running.url}/api/contacts/c1`);
      expect(one.status).toBe(200);
      const timeline = await one.json() as any;
      expect(timeline.contact.id).toBe('c1');
      const missing = await fetch(`${running.url}/api/contacts/nonexistent`);
      expect(missing.status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it('GET /api/search proxies core search', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    conn.db.insert(conn.schema.contacts).values({
      id: 'c1',
      fullName: 'Jane Doe',
      email: 'jane@stripe.com',
      company: 'Stripe',
      role: 'Engineer',
      seniority: 'senior',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/search?q=stripe`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.total).toBe(1);
      expect(body.contacts[0].id).toBe('c1');
      expect(body.facets).toBeDefined();
      expect(body.engine).toBeDefined();
      const badSort = await fetch(`${running.url}/api/search?sort=bogus`);
      expect(badSort.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it('GET /api/graph and /api/graph/path', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    // need at least two contacts for graph, edges table but graph with no edges returns empty
    conn.db.insert(conn.schema.contacts).values([
      { id: 'a', fullName: 'Alice', source: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'b', fullName: 'Bob', source: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]).run();
    // add edge a->b
    conn.db.insert(conn.schema.edges).values({
      id: 'e1',
      sourceId: 'a',
      targetId: 'b',
      relation: 'colleague',
      strength: 0.7,
      source: 'manual',
      confidence: 1,
      status: 'confirmed',
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const g = await fetch(`${running.url}/api/graph`);
      expect(g.status).toBe(200);
      const body = await g.json() as any;
      expect(body.nodes).toBeDefined();
      expect(body.edges).toBeDefined();
      const overview = await fetch(`${running.url}/api/graph/overview`);
      expect(overview.status).toBe(200);
      const p = await fetch(`${running.url}/api/graph/path?target=b&from=a`);
      expect(p.status).toBe(200);
      const plan = await p.json() as any;
      expect(plan.found).toBe(true);
      expect(plan.paths.length).toBeGreaterThan(0);
      // alias paths
      const p2 = await fetch(`${running.url}/api/graph/paths?target=b&from=a`);
      expect(p2.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('GET /api/analytics returns overview', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    conn.db.insert(conn.schema.contacts).values({
      id: 'c1',
      fullName: 'Jane',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/analytics`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.metrics).toBeDefined();
      expect(body.growth).toBeDefined();
      const net = await fetch(`${running.url}/api/analytics/network`);
      expect(net.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('POST /api/import creates a job and imports', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const csv = 'First Name,Last Name,Email Address,Company,Position,Connected On,URL\nJane,Doe,jane@example.com,Stripe,Engineer,01 Jan 2024,';
      const res = await fetch(`${running.url}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.job).toBeDefined();
      expect(body.job.type).toBe('import');
      expect(body.job.status).toBe('completed');
      expect(body.job.progress).toBe(100);
      expect(body.summary.imported).toBe(1);
      // GET /api/import/:id
      const get = await fetch(`${running.url}/api/import/${body.job.id}`);
      expect(get.status).toBe(200);
      const ranged = await fetch(`${running.url}/api/jobs/${body.job.id}`);
      expect(ranged.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('POST /api/scan creates a scan job', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/scan`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.job.type).toBe('scan');
      expect(body.job.status).toBe('completed');
      expect(body.job.progress).toBe(100);
    } finally {
      await running.close();
    }
  });

  it('GET /api/jobs lists and filters', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      // create two jobs via POST /api/jobs and POST /api/scan
      const r1 = await fetch(`${running.url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'enrich', metadata: { source: 'hunter' } }) });
      expect(r1.status).toBe(201);
      const r2 = await fetch(`${running.url}/api/scan`, { method: 'POST' });
      expect(r2.status).toBe(201);
      const list = await fetch(`${running.url}/api/jobs`);
      expect(list.status).toBe(200);
      const body = await list.json() as any;
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(body.jobs).toHaveLength(body.total);
      // filter
      const filtered = await fetch(`${running.url}/api/jobs?type=scan`);
      expect(filtered.status).toBe(200);
      const fBody = await filtered.json() as any;
      expect(fBody.jobs.every((j: any) => j.type === 'scan')).toBe(true);
      // cancel queued
      const jobId = (await r1.json() as any).job.id;
      const cancel = await fetch(`${running.url}/api/jobs/${jobId}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(200);
      const cancelled = await cancel.json() as any;
      expect(cancelled.job.status).toBe('cancelled');
    } finally {
      await running.close();
    }
  });

  it('GET /api/events is SSE and receives job events', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const controller = new AbortController();
      const eventsRes = await fetch(`${running.url}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.headers.get('content-type')).toContain('text/event-stream');
      // Read the stream until we see the initial retry line.
      const reader = eventsRes.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
        ]).catch(() => ({ value: undefined, done: true }) as any);
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
        if (text.includes('retry: 3000')) break;
      }
      controller.abort();
      try { await reader.cancel(); } catch {}
      expect(text).toContain('retry: 3000');
    } finally {
      await running.close();
    }
  });

  it('GET /api/settings returns server info', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/settings`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.server).toBeDefined();
      expect(body.database.dialect).toBe('sqlite');
      expect(body.auth.mode).toBe('local');
      // PUT should explain file-managed
      const put = await fetch(`${running.url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      expect(put.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('auth: non-loopback without token gets 401 for API', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const tokenPolicy: AuthPolicy = { mode: 'token', token: 'np_test123', installation: LOCAL_POLICY.installation };
    const app = await createApp({ conn, skipMigrate: true, auth: tokenPolicy, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'token' } } });
    const running = await startServer(app, { port: 0 });
    try {
      // health still public
      const h = await fetch(`${running.url}/api/health`);
      expect(h.status).toBe(200);
      const c = await fetch(`${running.url}/api/contacts`);
      expect(c.status).toBe(401);
      // with token via header
      const ok = await fetch(`${running.url}/api/contacts`, { headers: { Authorization: 'Bearer np_test123' } });
      expect(ok.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('POST /api/import with multipart file', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const csv = 'First Name,Last Name,Email Address,Company,Position,Connected On,URL\nJane,Doe,jane@example.com,Stripe,Engineer,01 Jan 2024,';
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), 'connections.csv');
      const res = await fetch(`${running.url}/api/import`, { method: 'POST', body: form });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.summary.imported).toBe(1);
      expect(body.job.type).toBe('import');
    } finally {
      await running.close();
    }
  });

  it('POST /api/import with raw text/csv', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const csv = 'First Name,Last Name,Email Address,Company,Position,Connected On,URL\nBob,Builder,bob@example.com,Acme,Manager,02 Jan 2024,';
      const res = await fetch(`${running.url}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: csv,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.summary.imported).toBe(1);
    } finally {
      await running.close();
    }
  });
});

describe('Phase 7 Job System', () => {
  it('Job lifecycle matches plan spec', async () => {
    const { createJobRegistry } = await import('./jobs/index');
    const reg = createJobRegistry();
    const job = reg.create({ type: 'import', metadata: { file: 'linkedin.csv' } });
    expect(job.id).toBeDefined();
    expect(job.type).toBe('import');
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.error).toBeNull();
    expect(job.metadata.file).toBe('linkedin.csv');
    // snake aliases exist
    expect(job.started_at).toBeNull();
    expect(job.completed_at).toBeNull();

    // start
    reg.start(job.id);
    expect(reg.get(job.id)!.status).toBe('running');
    expect(reg.get(job.id)!.startedAt).not.toBeNull();
    expect(reg.get(job.id)!.progress).toBeGreaterThan(0);

    // progress 15% discovering, 40% processing etc per plan
    reg.updateProgress(job.id, 15);
    expect(reg.get(job.id)!.progress).toBe(15);
    reg.updateProgress(job.id, 40);
    expect(reg.get(job.id)!.progress).toBe(40);
    reg.updateProgress(job.id, 90);
    expect(reg.get(job.id)!.progress).toBe(90);

    reg.complete(job.id, { imported: 10 });
    const done = reg.get(job.id)!;
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.completedAt).not.toBeNull();
    expect(done.metadata.imported).toBe(10);
  });

  it('supports all job types and statuses from plan', async () => {
    const { createJobRegistry, JOB_TYPES, JOB_STATUSES } = await import('./jobs/index');
    expect(JOB_TYPES).toEqual(expect.arrayContaining(['import','scan','enrich','index','embed','graph','analyze']));
    expect(JOB_STATUSES).toEqual(expect.arrayContaining(['queued','running','completed','failed','cancelled']));
    const reg = createJobRegistry();
    for (const type of JOB_TYPES) {
      const j = reg.create({ type });
      expect(j.type).toBe(type);
    }
    const j = reg.create({ type: 'enrich' });
    reg.fail(j.id, 'provider error');
    expect(reg.get(j.id)!.status).toBe('failed');
    expect(reg.get(j.id)!.error).toBe('provider error');
    const q = reg.create({ type: 'scan' });
    reg.cancel(q.id);
    expect(reg.get(q.id)!.status).toBe('cancelled');
  });
});
