// Phase 23 — webhook SSRF hardening: private-network targets are refused at
// create/update time AND on every delivery attempt (including redirect hops),
// unless NETPRO_WEBHOOKS_ALLOW_PRIVATE=1 opts a self-hosted receiver in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteConn } from '@netpro/db';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import {
  attemptDelivery,
  checkWebhookTarget,
  createWebhook,
  isPrivateNetworkUrl,
  isWebhookPrivateTargetAllowed,
  WebhookError,
  type WebhookDeliveryRow,
  type WebhookRow,
} from './webhooks';

const savedEnv = { ...process.env };

function testConn(): SqliteConn {
  const { conn } = createTestSqliteConn();
  // The committed migrations already seed the bootstrap workspace; keep the
  // insert as a belt-and-braces no-op if that ever changes.
  conn.db
    .insert(conn.schema.workspaces)
    .values({ id: 'default', name: 'Default', slug: 'default' })
    .onConflictDoNothing()
    .run();
  return conn;
}

function seedWebhook(conn: SqliteConn, url: string): WebhookRow {
  const now = new Date().toISOString();
  const row: WebhookRow = {
    id: 'wh_test',
    workspaceId: 'default',
    url,
    secret: 's3cret',
    eventAllowlist: ['contact.created'],
    status: 'enabled' as const,
    createdAt: now,
    updatedAt: now,
  };
  conn.db
    .insert(conn.schema.webhooks)
    .values({ ...row, eventAllowlist: JSON.stringify(row.eventAllowlist) })
    .run();
  return row;
}

function seedDelivery(conn: SqliteConn, webhookId: string): WebhookDeliveryRow {
  const now = new Date().toISOString();
  const row = {
    id: 'dlv_test',
    webhookId,
    event: 'contact.created' as const,
    payload: JSON.stringify({ schema: 1, event: 'contact.created', data: {} }),
    status: 'pending' as const,
    receivedAt: null,
    responseCode: null,
    errorMessage: null,
    attempt: 1,
    maxAttempts: 8,
    createdAt: now,
    updatedAt: now,
  };
  conn.db.insert(conn.schema.webhookDeliveries).values(row).run();
  return row;
}

beforeEach(() => {
  delete process.env.NETPRO_WEBHOOKS_ALLOW_PRIVATE;
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
});

describe('isPrivateNetworkUrl (phase 23)', () => {
  it('flags loopback, RFC 1918, link-local, and IPv6 private ranges', () => {
    const privateTargets = [
      'http://localhost:5678/hook',
      'http://foo.localhost/hook',
      'http://127.0.0.1/hook',
      'http://127.0.0.2/hook',
      'http://10.0.0.5/hook',
      'http://192.168.1.10/hook',
      'http://172.16.0.1/hook',
      'http://172.31.255.255/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/hook',
      'http://[::1]/hook',
      'http://[::]/hook',
      'http://[::ffff:127.0.0.1]/hook',
      'http://[fc00::1]/hook',
      'http://[fd12:3456::1]/hook',
      'http://[fe80::1]/hook',
      'http://n8n.local/hook',
      'http://metadata.internal/',
    ];
    for (const url of privateTargets) {
      expect(isPrivateNetworkUrl(url), url).toBe(true);
    }
  });

  it('passes public names and addresses, including near-miss suffix tricks', () => {
    const publicTargets = [
      'https://hooks.zapier.com/hooks/catch/123',
      'https://n8n.example.com/webhook/netpro',
      'http://8.8.8.8/hook',
      'http://11.0.0.1/hook',
      'http://172.15.0.1/hook',
      'http://172.32.0.1/hook',
      'http://192.167.1.1/hook',
      'http://169.253.169.254/hook',
      'http://127.0.0.1.evil.com/hook',
      'http://10.evil.com/hook',
      'http://localhost.evil.com/hook',
      'not a url',
    ];
    for (const url of publicTargets) {
      expect(isPrivateNetworkUrl(url), url).toBe(false);
    }
  });
});

describe('checkWebhookTarget (phase 23)', () => {
  it('refuses private targets by default and names the escape hatch', () => {
    expect(isWebhookPrivateTargetAllowed()).toBe(false);
    const blocked = checkWebhookTarget('http://127.0.0.1:5678/webhook/netpro');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain('private-network');
      expect(blocked.error).toContain('NETPRO_WEBHOOKS_ALLOW_PRIVATE=1');
    }
    expect(checkWebhookTarget('https://hooks.zapier.com/hooks/catch/123').ok).toBe(true);
  });

  it('still rejects malformed URLs, non-http(s) schemes, and embedded credentials', () => {
    expect(checkWebhookTarget('not a url').ok).toBe(false);
    expect(checkWebhookTarget('file:///etc/passwd').ok).toBe(false);
    expect(checkWebhookTarget('https://user:pass@example.com/hook').ok).toBe(false);
  });

  it('opens the hatch via NETPRO_WEBHOOKS_ALLOW_PRIVATE=1 or an explicit opt-in', () => {
    process.env.NETPRO_WEBHOOKS_ALLOW_PRIVATE = '1';
    expect(isWebhookPrivateTargetAllowed()).toBe(true);
    expect(checkWebhookTarget('http://127.0.0.1:5678/hook').ok).toBe(true);

    delete process.env.NETPRO_WEBHOOKS_ALLOW_PRIVATE;
    expect(checkWebhookTarget('http://127.0.0.1:5678/hook', { allowPrivate: true }).ok).toBe(
      true
    );
  });
});

describe('webhook SSRF enforcement (phase 23)', () => {
  it('rejects private targets at create time with a forbidden error', async () => {
    const conn = testConn();
    await expect(
      createWebhook(conn, { url: 'http://localhost:5678/hook', events: ['contact.created'] })
    ).rejects.toMatchObject({ code: 'forbidden' });

    process.env.NETPRO_WEBHOOKS_ALLOW_PRIVATE = 'true';
    const wh = await createWebhook(
      conn,
      { url: 'http://localhost:5678/hook', events: ['contact.created'] },
      undefined
    );
    expect(wh.url).toBe('http://localhost:5678/hook');
  });

  it('refuses to fetch a pre-existing private target without touching the network', async () => {
    const conn = testConn();
    // A row written before this phase (or by hand) bypasses create-time checks.
    const webhook = seedWebhook(conn, 'http://169.254.169.254/latest/meta-data/');
    const delivery = seedDelivery(conn, webhook.id);

    const fetchSpy = vi.fn(async () => new Response('should never happen', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await attemptDelivery(conn, delivery, webhook);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('pending'); // attempts remain, like any retryable failure
    expect(result.errorMessage).toContain('private-network');
    expect(result.errorMessage).toContain('NETPRO_WEBHOOKS_ALLOW_PRIVATE=1');
  });

  it('blocks a redirect hop into private space after fetching only the public URL', async () => {
    const conn = testConn();
    const webhook = seedWebhook(conn, 'https://hooks.example.com/catch/123');
    const delivery = seedDelivery(conn, webhook.id);

    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seen.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      })
    );

    const result = await attemptDelivery(conn, delivery, webhook);
    expect(seen).toEqual(['https://hooks.example.com/catch/123']);
    expect(result.errorMessage).toContain('private-network');
  });

  it('follows a public-to-public redirect and delivers', async () => {
    const conn = testConn();
    const webhook = seedWebhook(conn, 'https://hooks.example.com/catch/123');
    const delivery = seedDelivery(conn, webhook.id);

    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seen.push(String(url));
        if (String(url) === 'https://hooks.example.com/catch/123') {
          return new Response(null, {
            status: 308,
            headers: { location: 'https://hooks.example.com/catch/456' },
          });
        }
        return new Response('ok', { status: 200 });
      })
    );

    const result = await attemptDelivery(conn, delivery, webhook);
    expect(seen).toEqual(['https://hooks.example.com/catch/123', 'https://hooks.example.com/catch/456']);
    expect(result.status).toBe('delivered');
    expect(result.responseCode).toBe(200);
  });

  it('delivers to a private target when the hatch is explicitly open', async () => {
    process.env.NETPRO_WEBHOOKS_ALLOW_PRIVATE = '1';
    const conn = testConn();
    const webhook = seedWebhook(conn, 'http://localhost:5678/webhook/netpro');
    const delivery = seedDelivery(conn, webhook.id);

    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await attemptDelivery(conn, delivery, webhook);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('delivered');
  });

  it('keeps the WebhookError contract for blocked targets', () => {
    const err = new WebhookError('forbidden', 'nope');
    expect(err.code).toBe('forbidden');
    expect(err.name).toBe('WebhookError');
  });
});
