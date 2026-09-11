# Webhooks (v3.0 Phase 7)

NetPro can emit outbound webhooks with HMAC-SHA256 signatures, retry with backoff, dead-lettering, and delivery logs. Outbound only in v3.0 — no inbound webhook ingestion.

## Concepts

- **Webhook**: workspace-scoped, has URL (https/http), secret (32-byte hex, auto-generated), event allowlist (empty = all), status `enabled|disabled|paused`.
- **Event catalog**: `contact.created|updated|deleted`, `interaction.logged`, `followup.created|completed|updated`, `campaign.created|activated|step.confirmed|recipient.replied`, `content.added|updated`, `plugin.enabled|disabled`, `workspace.member.added|removed|role_changed`.
- **Delivery**: each emit creates a `webhook_deliveries` row with `pending|delivered|failed`, attempt count, max 8, response code, error message. Retries use exponential backoff: 60s base, doubling, max 32min.
- **Signature**: header `X-NetPro-Signature: t=<unix>,v1=<hmac>`, payload = `t.payload` HMAC-SHA256 with secret. Verification helper `verifyWebhookSignature(payload, header, secret)` tolerates 5min clock skew.

## Security

- URL validation: absolute http/https, no embedded credentials, max 2048 chars. Plain `http` is allowed (local receivers, tests) but `https` is recommended for anything crossing a network.
- SSRF guard (Phase 23, enforced): private-network targets — `localhost`/`*.localhost`, all of `127/8`, RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16` (the cloud metadata address), `0.0.0.0`/`::`, IPv6 unique-local `fc00::/7` and link-local `fe80::/10`, IPv4-mapped IPv6, `*.local`, `*.internal` — are **refused** when a webhook is created or updated (`forbidden`), and re-checked on **every delivery attempt**, so a row written before this phase or edited by hand cannot bypass it. Deliberate self-hosted receivers opt in with `NETPRO_WEBHOOKS_ALLOW_PRIVATE=1`.
- Redirects are followed manually (same POST, max 3 hops) with every hop re-validated: a public URL answering `302 → http://169.254.169.254/` fails instead of leaking the payload. Unparseable locations and excess hops fail closed.
- Delivery guardrails: 10s per-attempt timeout, payload capped at 256KB (`{ schema:1, event, workspace_id, actor, timestamp, data }`), max 8 attempts with exponential backoff (60s base, doubling, 32min cap), then dead-letter.
- Secret: generated via `crypto.randomBytes(32)`, hex. Rotation creates new secret, old signature invalid immediately. Responses are truncated (5KB) in logs; errors in delivery rows (1KB).
- Retention: deliveries purge after 30 days (configurable `NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS`, default 30) via the daily retention job.
- Known limit: hostname-to-IP rebinding between validation and delivery (a DNS name that resolves public, then private) is not pinned — webhook authors are authenticated operators, not remote attackers, so static validation plus redirect re-checks cover the practical threat. Treat webhook URLs as privileged configuration in team workspaces.

## CLI

```bash
netpro webhook list
netpro webhook add --url https://example.com/hook --events contact.created,interaction.logged
netpro webhook show <id>
netpro webhook update <id> --url https://new.example/hook --events contact.created --status paused
netpro webhook rotate <id>        # new secret printed once
netpro webhook test <id> --event contact.created
netpro webhook deliveries <id> --limit 20
netpro webhook redeliver <deliveryId>
netpro webhook rm <id>
netpro webhook events             # list catalog + receiver recipes
```

## Web

- Settings → Webhooks (`/settings/webhooks`): admin-only, lists webhooks masked (`...abcd`), create form (URL + event multi-select), enable/disable/pause toggle, rotate (shows new secret once), test (triggers delivery and shows result), deliveries table (status, attempt, response code), redeliver button, delete.
- APIs (owner/admin floors):
  - `GET /api/webhooks` — list masked
  - `POST /api/webhooks` — create, returns full secret once
  - `GET/PATCH/DELETE /api/webhooks/[id]`
  - `POST /api/webhooks/[id]/rotate` — new secret
  - `POST /api/webhooks/[id]/test` — body `{ event }`, creates and attempts delivery
  - `GET /api/webhooks/[id]/deliveries?limit=`
  - `POST /api/webhooks/deliveries/[deliveryId]/redeliver`
  - `GET /api/webhooks/events` — catalog + recipes

All routes use `requireMembership`/`requireScope` and write activity log (`webhook.created|updated|deleted|secret_rotated|event_emitted|redelivered`).

## Receiver recipes

The constant `WEBHOOK_RECEIVER_RECIPES` provides steps for:

- **Zapier**: Webhooks by Zapier → Catch Hook, paste URL, select events, enable, trigger event, verify signature if needed.
- **n8n**: Webhook node POST, copy URL, Function node to verify `X-NetPro-Signature` using HMAC-SHA256 (`t.payload`).
- **Make**: Custom webhook, copy URL, run once to learn payload, filter on `event`.
- **Node.js verification example**: 
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(payload, signature, secret) {
  const parts = Object.fromEntries(signature.split(',').map(p=>p.split('=')));
  const t = parts.t; const v1 = parts.v1;
  if (!t || !v1) return false;
  const now = Math.floor(Date.now()/1000);
  if (Math.abs(now - parseInt(t,10)) > 300) return false;
  const expected = createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
  return timingSafeEqual(Buffer.from(v1,'hex'), Buffer.from(expected,'hex'));
}
```

## Retention & audit

- Daily retention job (`runRetentionPurge`) now includes `webhook_deliveries` (30d). Configurable via `NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS`.
- Activity log: `webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.secret_rotated`, `webhook.event_emitted`, `webhook.redelivered`, plus `retention.purge` with `webhookDeliveriesDeleted` count.
- `GET /settings/activity` shows webhook audit rows.

## Migration

- `0014_webhooks` (both dialects): tables `webhooks` (id, workspace_id FK cascade, url, secret, event_allowlist JSON, status, created_at, updated_at) and `webhook_deliveries` (id, webhook_id FK cascade, event, payload, status, received_at, response_code, error_message, attempt, max_attempts, created_at, updated_at) with indexes `idx_webhooks_workspace`, `idx_webhooks_status`, `idx_webhook_deliveries_webhook`, `idx_webhook_deliveries_status`, `idx_webhook_deliveries_attempt`. Additive, idempotent.

## Future

- Inbound webhooks (e.g., receive events from external systems) deferred.
- Per-workspace rate limits and circuit breaker deferred.
- UI delivery log pagination beyond 200 deferred.
