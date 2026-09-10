// packages/core/src/webhooks.ts
// v3.0 Phase 7 — outbound webhooks with HMAC-SHA256 signatures,
// retry with backoff and dead-lettering, delivery logs, and receiver
// recipes for Zapier, n8n, and Make. Outbound only.

import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveScope, workspacePredicate, type WorkspaceScope } from './workspaces/scope';
import { writeActivityLog } from './crm/activity';
import { rawAll } from './search/indexer';

type Conn = SqliteConn | PgConn;

// ── Event catalog ───────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'interaction.logged',
  'followup.created',
  'followup.completed',
  'followup.updated',
  'campaign.created',
  'campaign.activated',
  'campaign.step.confirmed',
  'campaign.recipient.replied',
  'content.added',
  'content.updated',
  'plugin.enabled',
  'plugin.disabled',
  'workspace.member.added',
  'workspace.member.removed',
  'workspace.member.role_changed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

// ── Constants ───────────────────────────────────────────────────────────

export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRY_BASE_MS = 60_000;
export const WEBHOOK_RETRY_MAX_MS = 32 * 60_000;
export const WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export const WEBHOOK_STATUS = ['enabled', 'disabled', 'paused'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUS)[number];

export class WebhookError extends Error {
  constructor(
    public readonly code: 'not_found' | 'validation' | 'forbidden' | 'conflict' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface WebhookRow {
  id: string;
  workspaceId: string;
  url: string;
  secret: string;
  eventAllowlist: WebhookEvent[];
  status: WebhookStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  payload: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  receivedAt: string | null;
  responseCode: number | null;
  errorMessage: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDbRow {
  id: string;
  workspaceId: string;
  url: string;
  secret: string;
  eventAllowlist: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryDbRow {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  status: string;
  receivedAt: string | null;
  responseCode: number | null;
  errorMessage: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function parseAllowlist(raw: string): WebhookEvent[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => typeof e === 'string' && EVENT_SET.has(e)) as WebhookEvent[];
  } catch {
    return [];
  }
}

function toIsoString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v ?? new Date().toISOString());
}

function toWebhookRow(db: WebhookDbRow & { createdAt: unknown; updatedAt: unknown }): WebhookRow {
  return {
    id: db.id,
    workspaceId: db.workspaceId,
    url: db.url,
    secret: db.secret,
    eventAllowlist: parseAllowlist(db.eventAllowlist),
    status: (WEBHOOK_STATUS as readonly string[]).includes(db.status) ? (db.status as WebhookStatus) : 'paused',
    createdAt: toIsoString(db.createdAt),
    updatedAt: toIsoString(db.updatedAt),
  };
}

function toDeliveryRow(db: DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }): WebhookDeliveryRow {
  return {
    id: db.id,
    webhookId: db.webhookId,
    event: (EVENT_SET.has(db.event) ? db.event : 'contact.created') as WebhookEvent,
    payload: db.payload,
    status: db.status as WebhookDeliveryRow['status'],
    receivedAt: db.receivedAt ? toIsoString(db.receivedAt) : null,
    responseCode: db.responseCode,
    errorMessage: db.errorMessage,
    attempt: db.attempt,
    maxAttempts: db.maxAttempts,
    createdAt: toIsoString(db.createdAt),
    updatedAt: toIsoString(db.updatedAt),
  };
}

export function validateWebhookUrl(urlStr: string): { ok: true; url: URL } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'URL must be http or https' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'URL must not contain credentials' };
  }
  if (urlStr.length > 2048) {
    return { ok: false, error: 'URL too long (max 2048)' };
  }
  return { ok: true, url: u };
}

export function isPrivateNetworkUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (h.startsWith('10.') || h.startsWith('192.168.') || h === '0.0.0.0') return true;
    if (h.startsWith('172.')) {
      const second = parseInt(h.split('.')[1] ?? '0', 10);
      if (second >= 16 && second <= 31) return true;
    }
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
  } catch {
    return false;
  }
}

function validateEvents(events: string[]): WebhookEvent[] {
  if (!Array.isArray(events)) throw new WebhookError('validation', 'events must be an array');
  if (events.length === 0) throw new WebhookError('validation', 'At least one event must be selected');
  if (events.length > 50) throw new WebhookError('validation', 'Too many events (max 50)');
  const out: WebhookEvent[] = [];
  for (const e of events) {
    if (typeof e !== 'string' || !EVENT_SET.has(e)) {
      throw new WebhookError('validation', `Unknown event: ${e}`);
    }
    if (!out.includes(e as WebhookEvent)) out.push(e as WebhookEvent);
  }
  return out;
}

// ── Signature ───────────────────────────────────────────────────────────

export function signWebhookPayload(secret: string, payload: string, timestampSec?: number): string {
  const t = timestampSec ?? Math.floor(Date.now() / 1000);
  const hmac = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${hmac}`;
}

export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceMs = WEBHOOK_SIGNATURE_TOLERANCE_MS,
): boolean {
  if (!signatureHeader || !secret) return false;
  let tStr: string | null = null;
  let v1: string | null = null;
  for (const part of signatureHeader.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('t=')) tStr = trimmed.slice(2);
    else if (trimmed.startsWith('v1=')) v1 = trimmed.slice(3);
  }
  if (!tStr || !v1) return false;
  const tNum = parseInt(tStr, 10);
  if (!Number.isFinite(tNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tNum) * 1000 > toleranceMs) return false;
  const expected = createHmac('sha256', secret).update(`${tNum}.${payload}`).digest('hex');
  try {
    const a = Buffer.from(v1, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    const a = Buffer.from(v1);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

// ── Retry ───────────────────────────────────────────────────────────────

export function getRetryDelayMs(attempt: number): number {
  if (attempt <= 1) return WEBHOOK_RETRY_BASE_MS;
  const delay = WEBHOOK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, WEBHOOK_RETRY_MAX_MS);
}

// ── Core CRUD ───────────────────────────────────────────────────────────

export async function listWebhooks(conn: Conn, scope?: WorkspaceScope): Promise<WebhookRow[]> {
  const resolved = resolveScope(scope);
  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    const rows = (await conn.db.select().from(w).where(workspacePredicate(resolved, w.workspaceId)).orderBy(desc(w.createdAt))) as unknown as Array<WebhookDbRow & { createdAt: unknown; updatedAt: unknown }>;
    return rows.map(toWebhookRow);
  } else {
    const w = conn.schema.webhooks;
    const rows = (await conn.db.select().from(w).where(workspacePredicate(resolved, w.workspaceId)).orderBy(desc(w.createdAt))) as unknown as Array<WebhookDbRow & { createdAt: unknown; updatedAt: unknown }>;
    return rows.map(toWebhookRow);
  }
}

export async function getWebhook(conn: Conn, id: string, scope?: WorkspaceScope): Promise<WebhookRow | null> {
  const resolved = resolveScope(scope);
  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    const rows = (await conn.db.select().from(w).where(and(eq(w.id, id), workspacePredicate(resolved, w.workspaceId))).limit(1)) as unknown as Array<WebhookDbRow & { createdAt: unknown; updatedAt: unknown }>;
    if (rows.length === 0) return null;
    return toWebhookRow(rows[0]!);
  } else {
    const w = conn.schema.webhooks;
    const rows = (await conn.db.select().from(w).where(and(eq(w.id, id), workspacePredicate(resolved, w.workspaceId))).limit(1)) as unknown as Array<WebhookDbRow & { createdAt: unknown; updatedAt: unknown }>;
    if (rows.length === 0) return null;
    return toWebhookRow(rows[0]!);
  }
}

export async function createWebhook(
  conn: Conn,
  input: { url: string; events: string[]; status?: WebhookStatus },
  scope?: WorkspaceScope,
): Promise<WebhookRow> {
  const resolved = resolveScope(scope);
  const urlCheck = validateWebhookUrl(input.url);
  if (!urlCheck.ok) throw new WebhookError('validation', urlCheck.error);
  const events = validateEvents(input.events);
  const status = input.status ?? 'enabled';
  if (!(WEBHOOK_STATUS as readonly string[]).includes(status)) {
    throw new WebhookError('validation', `Invalid status: ${status}`);
  }
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const now = new Date().toISOString();

  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    await conn.db.insert(w).values({
      id,
      workspaceId: resolved.workspaceId,
      url: input.url,
      secret,
      eventAllowlist: JSON.stringify(events),
      status,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const w = conn.schema.webhooks;
    await conn.db.insert(w).values({
      id,
      workspaceId: resolved.workspaceId,
      url: input.url,
      secret,
      eventAllowlist: JSON.stringify(events),
      status,
      createdAt: now,
      updatedAt: now,
    });
  }

  await writeActivityLog(
    conn,
    {
      action: 'webhook.created',
      entityType: 'webhook',
      entityId: id,
      metadata: { url: input.url, events, workspaceId: resolved.workspaceId },
    },
    scope,
  );

  return {
    id,
    workspaceId: resolved.workspaceId,
    url: input.url,
    secret,
    eventAllowlist: events,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateWebhook(
  conn: Conn,
  id: string,
  patch: { url?: string; events?: string[]; status?: WebhookStatus },
  scope?: WorkspaceScope,
): Promise<WebhookRow> {
  const existing = await getWebhook(conn, id, scope);
  if (!existing) throw new WebhookError('not_found', `Webhook ${id} not found`);

  const updates: Record<string, unknown> = {};
  if (patch.url !== undefined) {
    const check = validateWebhookUrl(patch.url);
    if (!check.ok) throw new WebhookError('validation', check.error);
    updates.url = patch.url;
  }
  if (patch.events !== undefined) {
    const events = validateEvents(patch.events);
    updates.eventAllowlist = JSON.stringify(events);
  }
  if (patch.status !== undefined) {
    if (!(WEBHOOK_STATUS as readonly string[]).includes(patch.status)) {
      throw new WebhookError('validation', `Invalid status: ${patch.status}`);
    }
    updates.status = patch.status;
  }
  if (Object.keys(updates).length === 0) return existing;
  (updates as { updatedAt: string }).updatedAt = new Date().toISOString();

  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    await conn.db
      .update(w)
      .set(updates as never)
      .where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  } else {
    const w = conn.schema.webhooks;
    await conn.db
      .update(w)
      .set(updates as never)
      .where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  }

  await writeActivityLog(
    conn,
    {
      action: 'webhook.updated',
      entityType: 'webhook',
      entityId: id,
      metadata: { patch: Object.keys(patch), workspaceId: resolveScope(scope).workspaceId },
    },
    scope,
  );

  const refreshed = await getWebhook(conn, id, scope);
  if (!refreshed) throw new WebhookError('not_found', `Webhook ${id} not found after update`);
  return refreshed;
}

export async function deleteWebhook(conn: Conn, id: string, scope?: WorkspaceScope): Promise<void> {
  const existing = await getWebhook(conn, id, scope);
  if (!existing) throw new WebhookError('not_found', `Webhook ${id} not found`);

  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    const d = conn.schema.webhookDeliveries;
    await conn.db.delete(d).where(eq(d.webhookId, id));
    await conn.db.delete(w).where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  } else {
    const w = conn.schema.webhooks;
    const d = conn.schema.webhookDeliveries;
    await conn.db.delete(d).where(eq(d.webhookId, id));
    await conn.db.delete(w).where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  }

  await writeActivityLog(
    conn,
    {
      action: 'webhook.deleted',
      entityType: 'webhook',
      entityId: id,
      metadata: { workspaceId: resolveScope(scope).workspaceId },
    },
    scope,
  );
}

export async function rotateWebhookSecret(conn: Conn, id: string, scope?: WorkspaceScope): Promise<WebhookRow> {
  const existing = await getWebhook(conn, id, scope);
  if (!existing) throw new WebhookError('not_found', `Webhook ${id} not found`);
  const newSecret = generateWebhookSecret();

  if (conn.dialect === 'sqlite') {
    const w = conn.schema.webhooks;
    await conn.db
      .update(w)
      .set({ secret: newSecret, updatedAt: new Date().toISOString() } as never)
      .where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  } else {
    const w = conn.schema.webhooks;
    await conn.db
      .update(w)
      .set({ secret: newSecret, updatedAt: new Date().toISOString() } as never)
      .where(and(eq(w.id, id), workspacePredicate(resolveScope(scope), w.workspaceId)));
  }

  await writeActivityLog(
    conn,
    {
      action: 'webhook.secret_rotated',
      entityType: 'webhook',
      entityId: id,
      metadata: { workspaceId: resolveScope(scope).workspaceId },
    },
    scope,
  );

  const refreshed = await getWebhook(conn, id, scope);
  if (!refreshed) throw new WebhookError('not_found', `Webhook ${id} not found after rotation`);
  return refreshed;
}

// ── Delivery ────────────────────────────────────────────────────────────

export async function listWebhookDeliveries(
  conn: Conn,
  webhookId: string,
  scope?: WorkspaceScope,
  limit = 50,
): Promise<WebhookDeliveryRow[]> {
  const wh = await getWebhook(conn, webhookId, scope);
  if (!wh) throw new WebhookError('not_found', `Webhook ${webhookId} not found`);

  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db
      .select()
      .from(d)
      .where(eq(d.webhookId, webhookId))
      .orderBy(desc(d.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    return rows.map(toDeliveryRow);
  } else {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db
      .select()
      .from(d)
      .where(eq(d.webhookId, webhookId))
      .orderBy(desc(d.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    return rows.map(toDeliveryRow);
  }
}

export async function getWebhookDelivery(conn: Conn, deliveryId: string, scope?: WorkspaceScope): Promise<WebhookDeliveryRow | null> {
  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db.select().from(d).where(eq(d.id, deliveryId)).limit(1)) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    if (rows.length === 0) return null;
    const wh = await getWebhook(conn, rows[0]!.webhookId, scope);
    if (!wh) return null;
    return toDeliveryRow(rows[0]!);
  } else {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db.select().from(d).where(eq(d.id, deliveryId)).limit(1)) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    if (rows.length === 0) return null;
    const wh = await getWebhook(conn, rows[0]!.webhookId, scope);
    if (!wh) return null;
    return toDeliveryRow(rows[0]!);
  }
}

async function createDeliveryRow(conn: Conn, webhookId: string, event: WebhookEvent, payload: string): Promise<WebhookDeliveryRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    await conn.db.insert(d).values({
      id,
      webhookId,
      event,
      payload,
      status: 'pending',
      receivedAt: null,
      responseCode: null,
      errorMessage: null,
      attempt: 1,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    } as never);
  } else {
    const d = conn.schema.webhookDeliveries;
    await conn.db.insert(d).values({
      id,
      webhookId,
      event,
      payload,
      status: 'pending',
      receivedAt: null,
      responseCode: null,
      errorMessage: null,
      attempt: 1,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    } as never);
  }
  return {
    id,
    webhookId,
    event,
    payload,
    status: 'pending',
    receivedAt: null,
    responseCode: null,
    errorMessage: null,
    attempt: 1,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    createdAt: now,
    updatedAt: now,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text: text.slice(0, 5000) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg, { cause: e });
  } finally {
    clearTimeout(t);
  }
}

export async function attemptDelivery(conn: Conn, delivery: WebhookDeliveryRow, webhook: WebhookRow): Promise<WebhookDeliveryRow> {
  const payload = delivery.payload;
  const signature = signWebhookPayload(webhook.secret, payload);
  const now = new Date().toISOString();
  let result: { ok: boolean; status: number; text: string } | null = null;
  let error: string | null = null;
  try {
    result = await fetchWithTimeout(webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'NetPro-Webhooks/3.0',
        'X-NetPro-Signature': signature,
        'X-NetPro-Event': delivery.event,
        'X-NetPro-Delivery': delivery.id,
      },
      body: payload,
    });
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 1000) : String(e).slice(0, 1000);
  }

  const isSuccess = result?.ok && result.status >= 200 && result.status < 300;

  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    if (isSuccess) {
      await conn.db
        .update(d)
        .set({
          status: 'delivered',
          receivedAt: now,
          responseCode: result!.status,
          errorMessage: null,
          updatedAt: now,
        } as never)
        .where(eq(d.id, delivery.id));
      return { ...delivery, status: 'delivered', receivedAt: now, responseCode: result!.status, errorMessage: null, updatedAt: now };
    }
    const shouldDeadLetter = delivery.attempt >= delivery.maxAttempts;
    const newStatus = shouldDeadLetter ? 'failed' : 'pending';
    const errMsg = error ?? `HTTP ${result?.status ?? 'unknown'}: ${(result?.text ?? '').slice(0, 500)}`;
    await conn.db
      .update(d)
      .set({ status: newStatus, responseCode: result?.status ?? null, errorMessage: errMsg, updatedAt: now } as never)
      .where(eq(d.id, delivery.id));
    return { ...delivery, status: newStatus, responseCode: result?.status ?? null, errorMessage: errMsg, updatedAt: now };
  } else {
    const d = conn.schema.webhookDeliveries;
    if (isSuccess) {
      await conn.db
        .update(d)
        .set({
          status: 'delivered',
          receivedAt: now,
          responseCode: result!.status,
          errorMessage: null,
          updatedAt: now,
        } as never)
        .where(eq(d.id, delivery.id));
      return { ...delivery, status: 'delivered', receivedAt: now, responseCode: result!.status, errorMessage: null, updatedAt: now };
    }
    const shouldDeadLetter = delivery.attempt >= delivery.maxAttempts;
    const newStatus = shouldDeadLetter ? 'failed' : 'pending';
    const errMsg = error ?? `HTTP ${result?.status ?? 'unknown'}: ${(result?.text ?? '').slice(0, 500)}`;
    await conn.db
      .update(d)
      .set({ status: newStatus, responseCode: result?.status ?? null, errorMessage: errMsg, updatedAt: now } as never)
      .where(eq(d.id, delivery.id));
    return { ...delivery, status: newStatus, responseCode: result?.status ?? null, errorMessage: errMsg, updatedAt: now };
  }
}

export async function emitWebhookEvent(
  conn: Conn,
  event: WebhookEvent,
  payloadObj: Record<string, unknown>,
  scope?: WorkspaceScope,
): Promise<WebhookDeliveryRow[]> {
  if (!EVENT_SET.has(event)) throw new WebhookError('validation', `Unknown event: ${event}`);
  const resolved = resolveScope(scope);
  const envelope = {
    schema: 1,
    event,
    workspace_id: resolved.workspaceId,
    actor: resolved.userId,
    timestamp: new Date().toISOString(),
    data: payloadObj,
  };
  const payloadStr = JSON.stringify(envelope);
  if (payloadStr.length > 256_000) throw new WebhookError('validation', 'Payload too large (max 256KB)');

  const webhooks = await listWebhooks(conn, resolved);
  const matching = webhooks.filter((wh) => {
    if (wh.status !== 'enabled') return false;
    if (wh.eventAllowlist.length === 0) return true;
    return wh.eventAllowlist.includes(event);
  });

  const deliveries: WebhookDeliveryRow[] = [];
  for (const wh of matching) {
    const delivery = await createDeliveryRow(conn, wh.id, event, payloadStr);
    try {
      const attempted = await attemptDelivery(conn, delivery, wh);
      deliveries.push(attempted);
    } catch {
      deliveries.push(delivery);
    }
  }

  if (matching.length > 0) {
    await writeActivityLog(
      conn,
      {
        action: 'webhook.event_emitted',
        entityType: 'webhook',
        metadata: { event, matchedWebhooks: matching.length, workspaceId: resolved.workspaceId },
      },
      resolved,
    );
  }
  return deliveries;
}

export async function retryPendingDeliveries(
  conn: Conn,
  scope?: WorkspaceScope,
): Promise<{ retried: number; delivered: number; failed: number }> {
  const resolved = resolveScope(scope);

  // Raw query for join
  const pending = (await rawAll(
    conn as never,
    sql`SELECT wd.*, wh.url as webhook_url, wh.secret as webhook_secret, wh.status as webhook_status, wh.workspace_id as webhook_workspace
        FROM webhook_deliveries wd
        JOIN webhooks wh ON wh.id = wd.webhook_id
        WHERE wh.workspace_id = ${resolved.workspaceId}
          AND wd.status = 'pending'
          AND wd.attempt < wd.max_attempts
        ORDER BY wd.created_at ASC
        LIMIT 50`,
  )) as unknown as Array<DeliveryDbRow & { webhook_url: string; webhook_secret: string; webhook_status: string; webhook_workspace: string; createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;

  let delivered = 0;
  let failed = 0;

  for (const row of pending) {
    const delivery: WebhookDeliveryRow = {
      id: row.id,
      webhookId: row.webhookId,
      event: row.event as WebhookEvent,
      payload: row.payload,
      status: row.status as WebhookDeliveryRow['status'],
      receivedAt: row.receivedAt,
      responseCode: row.responseCode,
      errorMessage: row.errorMessage,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const webhook: WebhookRow = {
      id: row.webhookId,
      workspaceId: row.webhook_workspace,
      url: row.webhook_url,
      secret: row.webhook_secret,
      eventAllowlist: [],
      status: row.webhook_status as WebhookStatus,
      createdAt: '',
      updatedAt: '',
    };
    if (webhook.status !== 'enabled') continue;

    const nextAttempt = delivery.attempt + 1;
    if (conn.dialect === 'sqlite') {
      const d = conn.schema.webhookDeliveries;
      await conn.db.update(d).set({ attempt: nextAttempt, updatedAt: new Date().toISOString() } as never).where(eq(d.id, delivery.id));
    } else {
      const d = conn.schema.webhookDeliveries;
      await conn.db.update(d).set({ attempt: nextAttempt, updatedAt: new Date().toISOString() } as never).where(eq(d.id, delivery.id));
    }
    const toRetry = { ...delivery, attempt: nextAttempt };
    const result = await attemptDelivery(conn, toRetry, webhook);
    if (result.status === 'delivered') delivered++;
    else if (result.status === 'failed' && result.attempt >= result.maxAttempts) failed++;
  }

  return { retried: pending.length, delivered, failed };
}

export async function redeliverWebhookDelivery(conn: Conn, deliveryId: string, scope?: WorkspaceScope): Promise<WebhookDeliveryRow> {
  const resolved = resolveScope(scope);
  let row: (DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }) | undefined;
  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db.select().from(d).where(eq(d.id, deliveryId)).limit(1)) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    row = rows[0];
  } else {
    const d = conn.schema.webhookDeliveries;
    const rows = (await conn.db.select().from(d).where(eq(d.id, deliveryId)).limit(1)) as unknown as Array<DeliveryDbRow & { createdAt: unknown; updatedAt: unknown; receivedAt: unknown }>;
    row = rows[0];
  }
  if (!row) throw new WebhookError('not_found', `Delivery ${deliveryId} not found`);
  const delivery = toDeliveryRow(row);
  const wh = await getWebhook(conn, delivery.webhookId, resolved);
  if (!wh) throw new WebhookError('not_found', `Webhook ${delivery.webhookId} not found`);

  if (conn.dialect === 'sqlite') {
    const d = conn.schema.webhookDeliveries;
    await conn.db
      .update(d)
      .set({ status: 'pending', attempt: 1, errorMessage: null, responseCode: null, updatedAt: new Date().toISOString() } as never)
      .where(eq(d.id, deliveryId));
  } else {
    const d = conn.schema.webhookDeliveries;
    await conn.db
      .update(d)
      .set({ status: 'pending', attempt: 1, errorMessage: null, responseCode: null, updatedAt: new Date().toISOString() } as never)
      .where(eq(d.id, deliveryId));
  }

  const reset = { ...delivery, status: 'pending' as const, attempt: 1, errorMessage: null, responseCode: null };
  const result = await attemptDelivery(conn, reset, wh);

  await writeActivityLog(
    conn,
    {
      action: 'webhook.redelivered',
      entityType: 'webhook_delivery',
      entityId: deliveryId,
      metadata: { webhookId: wh.id, workspaceId: resolved.workspaceId },
    },
    resolved,
  );

  return result;
}

// ── Retention ───────────────────────────────────────────────────────────

export async function purgeExpiredWebhookDeliveries(
  conn: Conn,
  options: { now?: Date; olderThanDays?: number; scope?: WorkspaceScope } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const days = options.olderThanDays ?? WEBHOOK_DELIVERY_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const resolved = options.scope ? resolveScope(options.scope) : undefined;

  let deleted = 0;
  if (resolved) {
    const rows = await rawAll<{ id: string }>(
      conn as never,
      sql`SELECT wd.id FROM webhook_deliveries wd
          JOIN webhooks wh ON wh.id = wd.webhook_id
          WHERE wh.workspace_id = ${resolved.workspaceId}
            AND wd.created_at < ${cutoff}`,
    );
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (const chunk of chunkArray(ids, 100)) {
        if (conn.dialect === 'sqlite') {
          const d = conn.schema.webhookDeliveries;
          for (const id of chunk) {
            await conn.db.delete(d).where(eq(d.id, id));
          }
        } else {
          const d = conn.schema.webhookDeliveries;
          for (const id of chunk) {
            await conn.db.delete(d).where(eq(d.id, id));
          }
        }
        deleted += chunk.length;
      }
    }
  } else {
    const rows = await rawAll<{ id: string }>(conn as never, sql`SELECT id FROM webhook_deliveries WHERE created_at < ${cutoff}`);
    deleted = rows.length;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (const chunk of chunkArray(ids, 100)) {
        if (conn.dialect === 'sqlite') {
          const d = conn.schema.webhookDeliveries;
          for (const id of chunk) {
            await conn.db.delete(d).where(eq(d.id, id));
          }
        } else {
          const d = conn.schema.webhookDeliveries;
          for (const id of chunk) {
            await conn.db.delete(d).where(eq(d.id, id));
          }
        }
      }
    }
  }
  return { deleted };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Receiver recipes ────────────────────────────────────────────────────

export const WEBHOOK_RECEIVER_RECIPES = {
  zapier: {
    name: 'Zapier (Webhooks by Zapier)',
    steps: [
      'Create a new Zap, trigger = Webhooks by Zapier → Catch Hook',
      'Copy the Zapier webhook URL into NetPro /settings/webhooks',
      'Select events, enable, then trigger an event in NetPro',
      'Zapier will show the payload; verify X-NetPro-Signature if needed',
    ],
  },
  n8n: {
    name: 'n8n (Webhook node)',
    steps: [
      'Add a Webhook node, method POST, path e.g. /netpro',
      'Copy its URL into NetPro',
      'In n8n, add a Function node to verify X-NetPro-Signature using HMAC-SHA256',
      'Use Node crypto to compute HMAC of timestamp plus dot plus payload and compare with v1',
    ],
  },
  make: {
    name: 'Make (Custom webhook)',
    steps: [
      'Create scenario → Webhooks → Custom webhook → Add',
      'Copy URL into NetPro, enable',
      'Run once to learn payload structure',
      'Use Make filters on event field',
    ],
  },
  node: {
    name: 'Node.js verification example',
    code: [
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "function verify(payload, signature, secret) {",
      "  const parts = Object.fromEntries(signature.split(',').map(p=>p.split('=')));",
      "  const t = parts.t; const v1 = parts.v1;",
      "  if (!t || !v1) return false;",
      "  const now = Math.floor(Date.now()/1000);",
      "  if (Math.abs(now - parseInt(t,10)) > 300) return false;",
      "  const expected = createHmac('sha256', secret).update(t + '.' + payload).digest('hex');",
      "  return timingSafeEqual(Buffer.from(v1,'hex'), Buffer.from(expected,'hex'));",
      "}",
    ].join('\n'),
  },
} as const;

// ── Convenience wrappers for web API ───────────────────────────────────

export async function testWebhook(
  conn: Conn,
  webhookId: string,
  event: string = 'test.ping',
  scope?: WorkspaceScope,
): Promise<WebhookDeliveryRow> {
  const wh = await getWebhook(conn, webhookId, scope);
  if (!wh) throw new WebhookError('not_found', `Webhook ${webhookId} not found`);
  const payload = JSON.stringify({
    schema: 1,
    event,
    workspace_id: wh.workspaceId,
    timestamp: new Date().toISOString(),
    data: { test: true, webhookId },
  });
  const delivery = await createDeliveryRow(conn, wh.id, (EVENT_SET.has(event) ? event : 'contact.created') as WebhookEvent, payload);
  try {
    return await attemptDelivery(conn, delivery, wh);
  } catch {
    return delivery;
  }
}

export const redeliverWebhook = redeliverWebhookDelivery;

