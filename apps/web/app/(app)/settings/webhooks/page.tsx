// v3.0 Phase 7 — webhooks settings page (admin+).

import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { listWebhooks } from '@netpro/core/src/webhooks';
import WebhooksClient from './client';

export const metadata = {
  title: 'Webhooks — NetPro',
};
export const dynamic = 'force-dynamic';

export default async function WebhooksPage() {
  const scope = await requireMembership('admin');
  const webhooks = await listWebhooks(conn, scope);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-2">Webhooks</h1>
      <p className="text-sm text-slate-500 mb-2">
        Outbound webhooks push your workspace data to your endpoints — Zapier, n8n, Make, or any URL you control.
        Signed with HMAC-SHA256 (X-NetPro-Signature), retried with exponential backoff (max 8 attempts), dead-lettered after failure.
      </p>
      <p className="text-xs text-slate-400 mb-6">
        Admin-only. URLs are operator-configured; private-network targets (localhost, 10.x, 192.168.x) are allowed but flagged — self-hosted n8n is a valid target.
        Secrets are shown once at creation/rotation. Event allowlist per webhook; payloads are your data (no third-party PII). Deliveries retained 30 days.
      </p>
      <WebhooksClient initialWebhooks={webhooks} workspaceId={scope.workspaceId} role={scope.role} />
    </div>
  );
}
