import { Command } from 'commander';
import { createDb } from '@netpro/db';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  listWebhookDeliveries,
  emitWebhookEvent,
  redeliverWebhookDelivery,
  retryPendingDeliveries,
  WEBHOOK_EVENTS,
  isPrivateNetworkUrl,
  WebhookError,
} from '@netpro/core/src/webhooks';
import { resolveCliScope } from '../db';

function getConn() {
  return createDb();
}

export function registerWebhookCommand(program: Command): void {
  const webhook = program.command('webhook').description('Manage outbound webhooks (v3.0 Phase 7)');

  webhook
    .command('list')
    .description('List webhooks in workspace')
    .option('--json', 'Output JSON')
    .action(async function (opts) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const webhooks = await listWebhooks(conn, scope);
      if (opts.json) {
        console.log(JSON.stringify(webhooks, null, 2));
      } else {
        if (webhooks.length === 0) {
          console.log('No webhooks. Add one with: netpro webhook add https://example.com/hook --events contact.created,interaction.logged');
        } else {
          console.log(`Webhooks (${webhooks.length}):`);
          for (const wh of webhooks) {
            const events = wh.eventAllowlist.length ? wh.eventAllowlist.join(',') : '(all)';
            const privateFlag = isPrivateNetworkUrl(wh.url) ? ' [private-network warning]' : '';
            console.log(`- ${wh.id} ${wh.status} ${wh.url}${privateFlag}`);
            console.log(`  events: ${events}  created: ${wh.createdAt}`);
          }
        }
      }
    });

  webhook
    .command('events')
    .description('List available webhook events')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      if (opts.json) {
        console.log(JSON.stringify(WEBHOOK_EVENTS, null, 2));
      } else {
        console.log('Available events:');
        for (const e of WEBHOOK_EVENTS) console.log(`- ${e}`);
      }
    });

  webhook
    .command('add')
    .description('Add a webhook')
    .argument('<url>', 'Target URL (https://...)')
    .option('--events <events>', 'Comma-separated events (or empty for all)', '')
    .option('--status <status>', 'Status: enabled|disabled|paused', 'enabled')
    .option('--json', 'Output JSON')
    .action(async function (url: string, opts) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const events = opts.events
        ? opts.events.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      // If empty, default to all documented core events per plan? But require at least one per validation.
      // For UX, if empty, use the 10 primary events.
      const finalEvents =
        events.length > 0
          ? events
          : [
              'contact.created',
              'contact.updated',
              'interaction.logged',
              'followup.completed',
              'campaign.activated',
              'campaign.step.confirmed',
              'campaign.recipient.replied',
              'content.added',
              'plugin.enabled',
              'workspace.member.added',
            ];

      try {
        const wh = await createWebhook(conn, { url, events: finalEvents, status: opts.status }, scope);
        if (opts.json) {
          console.log(JSON.stringify(wh, null, 2));
        } else {
          console.log(`Created webhook ${wh.id}`);
          console.log(`URL: ${wh.url}`);
          if (isPrivateNetworkUrl(wh.url)) {
            console.log('⚠️  Private-network target — allowed but flagged (self-hosted n8n/localhost).');
          }
          console.log(`Events: ${wh.eventAllowlist.join(',')}`);
          console.log(`Status: ${wh.status}`);
          console.log(`Secret (shown once): ${wh.secret}`);
          console.log(`Save the secret — it is used to verify X-NetPro-Signature. Rotate with: netpro webhook rotate ${wh.id}`);
        }
      } catch (e) {
        if (e instanceof WebhookError) {
          console.error(`Error (${e.code}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });

  webhook
    .command('rm')
    .description('Delete a webhook')
    .argument('<id>', 'Webhook ID')
    .action(async function (id: string) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      try {
        await deleteWebhook(conn, id, scope);
        console.log(`Deleted ${id}`);
      } catch (e) {
        if (e instanceof WebhookError) {
          console.error(`Error (${e.code}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });

  webhook
    .command('enable')
    .description('Enable a webhook')
    .argument('<id>', 'Webhook ID')
    .action(async function (id: string) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const wh = await updateWebhook(conn, id, { status: 'enabled' }, scope);
      console.log(`Enabled ${wh.id}`);
    });

  webhook
    .command('disable')
    .description('Disable a webhook')
    .argument('<id>', 'Webhook ID')
    .action(async function (id: string) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const wh = await updateWebhook(conn, id, { status: 'disabled' }, scope);
      console.log(`Disabled ${wh.id}`);
    });

  webhook
    .command('rotate')
    .description('Rotate webhook secret (shown once)')
    .argument('<id>', 'Webhook ID')
    .option('--json', 'Output JSON')
    .action(async function (id: string, opts) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const wh = await rotateWebhookSecret(conn, id, scope);
      if (opts.json) {
        console.log(JSON.stringify({ id: wh.id, secret: wh.secret }, null, 2));
      } else {
        console.log(`Rotated secret for ${wh.id}`);
        console.log(`New secret (shown once): ${wh.secret}`);
      }
    });

  webhook
    .command('deliveries')
    .description('List deliveries for a webhook')
    .argument('<webhookId>', 'Webhook ID')
    .option('--limit <n>', 'Limit', '20')
    .option('--json', 'Output JSON')
    .action(async function (webhookId: string, opts) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const limit = Number(opts.limit) || 20;
      try {
        const deliveries = await listWebhookDeliveries(conn, webhookId, scope, limit);
        if (opts.json) {
          console.log(JSON.stringify(deliveries, null, 2));
        } else {
          if (deliveries.length === 0) console.log('No deliveries yet.');
          else {
            for (const d of deliveries) {
              console.log(`- ${d.id} ${d.event} ${d.status} attempt ${d.attempt}/${d.maxAttempts} ${d.responseCode ?? ''} ${d.errorMessage ?? ''}`);
            }
          }
        }
      } catch (e) {
        if (e instanceof WebhookError) {
          console.error(`Error (${e.code}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });

  webhook
    .command('test')
    .description('Send a test event to a webhook')
    .argument('<webhookId>', 'Webhook ID')
    .option('--event <event>', 'Event to test', 'contact.created')
    .action(async function (webhookId: string, opts) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const wh = await getWebhook(conn, webhookId, scope);
      if (!wh) {
        console.error(`Webhook ${webhookId} not found`);
        process.exit(1);
      }
      const event = opts.event as typeof WEBHOOK_EVENTS[number];
      if (!WEBHOOK_EVENTS.includes(event as never)) {
        console.error(`Unknown event ${event}. Use: netpro webhook events`);
        process.exit(1);
      }
      console.log(`Sending test ${event} to ${wh.url}...`);
      const deliveries = await emitWebhookEvent(conn, event, { test: true, webhookId }, scope);
      const relevant = deliveries.find((d) => d.webhookId === webhookId);
      if (!relevant) {
        console.log('No delivery created (webhook disabled or event not in allowlist).');
      } else {
        console.log(`Delivery ${relevant.id}: ${relevant.status} HTTP ${relevant.responseCode ?? 'n/a'}`);
        if (relevant.errorMessage) console.log(`Error: ${relevant.errorMessage}`);
      }
    });

  webhook
    .command('redeliver')
    .description('Redeliver a failed delivery')
    .argument('<deliveryId>', 'Delivery ID')
    .action(async function (deliveryId: string) {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      try {
        const result = await redeliverWebhookDelivery(conn, deliveryId, scope);
        console.log(`Redelivered ${result.id}: ${result.status} HTTP ${result.responseCode ?? 'n/a'}`);
        if (result.errorMessage) console.log(`Error: ${result.errorMessage}`);
      } catch (e) {
        if (e instanceof WebhookError) {
          console.error(`Error (${e.code}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });

  webhook
    .command('retry')
    .description('Retry all pending deliveries in workspace (admin tool)')
    .action(async function () {
      const conn = getConn();
      const scope = await resolveCliScope(this, conn);
      const result = await retryPendingDeliveries(conn, scope);
      console.log(`Retried ${result.retried}, delivered ${result.delivered}, failed ${result.failed}`);
    });
}
