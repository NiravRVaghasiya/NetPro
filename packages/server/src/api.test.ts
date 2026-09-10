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

  it('POST /api/scan creates a scan job with the Phase 14 result snapshot', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    // Seed a contact and a confirmed edge so the scan result is non-trivial.
    conn.db.insert(conn.schema.contacts).values({
      id: 's1',
      fullName: 'Jane Doe',
      company: 'Stripe',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    conn.db.insert(conn.schema.contacts).values({
      id: 's2',
      fullName: 'John Smith',
      company: 'Acme',
      source: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    conn.db.insert(conn.schema.edges).values({
      id: 'e1',
      sourceId: 's1',
      targetId: 's2',
      relation: 'colleague',
      source: 'test',
      status: 'confirmed',
      confidence: 1,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/scan`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.job.type).toBe('scan');
      expect(body.job.status).toBe('completed');
      expect(body.job.progress).toBe(100);
      const result = body.result;
      expect(result).toBeDefined();
      expect(result.source).toBe('linkedin_csv');
      expect(result.total).toBe(2);
      expect(result.processed).toBe(2);
      expect(result.relationships).toBe(1);
      expect(result.index).toMatchObject({ scanned: 2, indexed: 2 });
      expect(result.enrichment).toMatchObject({ configured: false, enriched: 0 });
      // GET /api/scan/:id carries the same snapshot.
      const get = await fetch(`${running.url}/api/scan/${body.job.id}`);
      expect(get.status).toBe(200);
      const gbody = await get.json() as any;
      expect(gbody.job.metadata.result.total).toBe(2);
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

  it('POST /api/import/preview validates without writing', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const csv = [
        'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
        'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
        ',,,,,,',
      ].join('\n');
      const res = await fetch(`${running.url}/api/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.preview.totalRows).toBe(2);
      expect(body.preview.validRows).toBe(1);
      expect(body.preview.invalidRows).toBe(1);
      expect(body.preview.issues).toEqual([{ row: 3, reason: 'missing name' }]);
      // Preview must not write any contacts.
      const rows = conn.db.select().from(conn.schema.contacts).all();
      expect(rows).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('POST /api/import/preview rejects a missing CSV', async () => {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    const running = await startServer(app, { port: 0 });
    try {
      const res = await fetch(`${running.url}/api/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
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
type SearchHitJson = {
  id: string;
  tags: string[] | null;
  skills: string[] | null;
  matchReasons: Array<{ kind: string; text: string }>;
};
type SearchResponseJson = { total: number; contacts: SearchHitJson[] };
type RankedPathJson = {
  hops: number;
  score: { score: number; weakestTie: number | null; avgHopStrength: number };
  intermediaries: unknown[];
  ask: { suggestion: string };
};
type PathPlanJson = { found: boolean; paths: RankedPathJson[] };
type ApiErrorJson = { error?: string; code?: string };

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

describe('Phase 12 Search Experience', () => {
  async function seedSearchDb() {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const now = new Date().toISOString();
    conn.db.insert(conn.schema.contacts).values([
      {
        id: 'c1', fullName: 'Sarah Chen', email: 'sarah@acme.com', company: 'Acme',
        role: 'Senior Engineer', location: 'Berlin', relationshipScore: 0.85,
        tags: ['founder', 'ai'], skills: ['python'], source: 'test',
        createdAt: now, updatedAt: now,
      },
      {
        id: 'c2', fullName: 'Alex Rivera', email: 'alex@globex.com', company: 'Globex',
        role: 'Designer', location: 'Paris', relationshipScore: 0.4,
        tags: ['design'], skills: ['kubernetes'], source: 'test',
        createdAt: now, updatedAt: now,
      },
    ]).run();
    // One confirmed edge so a community exists (both contacts, label "acme" —
    // dominant company, lowercased; tie broken alphabetically).
    conn.db.insert(conn.schema.edges).values({
      id: 'e1', sourceId: 'c1', targetId: 'c2', relation: 'colleague',
      strength: 0.7, source: 'manual', confidence: 1, status: 'confirmed',
      discoveredAt: now, updatedAt: now,
    }).run();
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    return startServer(app, { port: 0 });
  }

  it('GET /api/search explains every hit and carries skills/tags', async () => {
    const running = await seedSearchDb();
    try {
      const { status, body } = await getJson<SearchResponseJson>(`${running.url}/api/search?q=sarah`);
      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.contacts[0].id).toBe('c1');
      expect(body.contacts[0].tags).toEqual(['founder', 'ai']);
      expect(body.contacts[0].skills).toEqual(['python']);
      const reasons = body.contacts[0].matchReasons;
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.map((r) => r.text)).toContain('Name matches "sarah"');
    } finally {
      await running.close();
    }
  });

  it('GET /api/search supports name/tags/community filters', async () => {
    const running = await seedSearchDb();
    try {
      const byName = await getJson<SearchResponseJson>(`${running.url}/api/search?name=alex`);
      expect(byName.body.contacts.map((c) => c.id)).toEqual(['c2']);

      const byTags = await getJson<SearchResponseJson>(`${running.url}/api/search?tags=founder,ai`);
      expect(byTags.body.contacts.map((c) => c.id)).toEqual(['c1']);

      // The single community holds both contacts; an unknown one holds none.
      const byCommunity = await getJson<SearchResponseJson>(`${running.url}/api/search?community=0`);
      expect(byCommunity.body.total).toBe(2);
      const unknown = await getJson<SearchResponseJson>(`${running.url}/api/search?community=nope`);
      expect(unknown.body.total).toBe(0);

      // minScore still composes with the new filters.
      const strong = await getJson<SearchResponseJson>(`${running.url}/api/search?tags=founder&minScore=0.5`);
      expect(strong.body.contacts.map((c) => c.id)).toEqual(['c1']);
      expect(strong.body.contacts[0].matchReasons.map((r) => r.text)).toContain(
        'Relationship strength 0.85 (minimum 0.5)'
      );
    } finally {
      await running.close();
    }
  });
});

describe('Phase 13 Pathfinder', () => {
  async function seedChainDb() {
    const { conn } = scratchDb();
    await runMigrations(conn);
    const now = new Date().toISOString();
    conn.db.insert(conn.schema.contacts).values([
      { id: 'a', fullName: 'Ada', source: 'test', relationshipScore: 0.9, createdAt: now, updatedAt: now },
      { id: 'b', fullName: 'Bob', source: 'test', relationshipScore: 0.8, createdAt: now, updatedAt: now },
      { id: 'c', fullName: 'Cara', source: 'test', relationshipScore: 0.7, createdAt: now, updatedAt: now },
      { id: 'd', fullName: 'Dan', source: 'test', relationshipScore: 0.1, createdAt: now, updatedAt: now },
    ]).run();
    // a—b—c plus a direct a—c edge, so k=2 asks for two ranked alternatives.
    let n = 0;
    for (const [s, t, strength] of [['a', 'b', 0.9], ['b', 'c', 0.8], ['a', 'c', 0.2]] as const) {
      conn.db.insert(conn.schema.edges).values({
        id: `e${++n}`, sourceId: s, targetId: t, relation: 'colleague',
        strength, source: 'manual', confidence: 1, status: 'confirmed',
        discoveredAt: now, updatedAt: now,
      }).run();
    }
    const app = await createApp({ conn, skipMigrate: true, auth: LOCAL_POLICY, config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } } });
    return startServer(app, { port: 0 });
  }

  it('GET /api/graph/path ranks alternatives with strength stats', async () => {
    const running = await seedChainDb();
    try {
      const { status, body: plan } = await getJson<PathPlanJson>(`${running.url}/api/graph/path?target=c&from=a&alt=2`);
      expect(status).toBe(200);
      // Shortest chains only: the direct 1-hop edge wins; k=2 asks for two.
      expect(plan.found).toBe(true);
      expect(plan.paths.length).toBeGreaterThanOrEqual(1);
      const top = plan.paths[0];
      expect(top.hops).toBe(1);
      expect(top.score.score).toBeGreaterThan(0);
      expect(top.score.avgHopStrength).toBeGreaterThan(0);
      expect(top.intermediaries).toEqual([]);
      expect(top.ask.suggestion).toContain('Ada');
    } finally {
      await running.close();
    }
  });

  it('keeps depth and alternatives independent', async () => {
    const running = await seedChainDb();
    try {
      // d is disconnected — and k must not widen the hop budget the way the
      // old `depth ?? k` fallback did.
      const unreachable = await getJson<PathPlanJson>(`${running.url}/api/graph/path?target=d&from=a&k=5`);
      expect(unreachable.status).toBe(200);
      expect(unreachable.body.found).toBe(false);

      // Alternatives clamp to the ranked-list budget instead of failing.
      const clamped = await getJson<PathPlanJson>(`${running.url}/api/graph/path?target=c&from=a&k=99`);
      expect(clamped.status).toBe(200);
      expect(clamped.body.paths.length).toBeLessThanOrEqual(5);

      // Genuine misuse is a 400 with a code surfaces can render.
      const missing = await getJson<ApiErrorJson>(`${running.url}/api/graph/path`);
      expect(missing.status).toBe(400);
      const badDepth = await getJson<ApiErrorJson>(`${running.url}/api/graph/path?target=c&depth=0`);
      expect(badDepth.status).toBe(400);
      expect(badDepth.body.code).toBe('invalid_input');
    } finally {
      await running.close();
    }
  });
});
