// apps/cli/src/commands/campaign.ts
//
// `netpro campaign` — draft-only batch outreach from the terminal. NetPro
// composes and personalizes the messages; a human sends them from their own
// mailbox/LinkedIn and records the result. Every confirmed send is logged as a
// real CRM interaction (feeding contact scoring), and inbound replies cancel
// the remaining drip. The blueprint reference:
//
//   /outreach/campaigns → Batch outreach with drip sequences
//
// House pattern (mirrors commands/track.ts): exported execute*/render*
// functions take an injected conn and clock (testable without a process), and
// the commander actions are thin wrappers that open the database and print.
import type { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveContactRef } from '@netpro/core/src/ai';
import { CrmError } from '@netpro/core/src/crm';
import {
  addRecipients,
  campaignSequence,
  createCampaign,
  findRecipientByContact,
  listCampaigns,
  markRecipientReplied,
  markRecipientSent,
  markRecipientSkipped,
  renderCampaign,
  setCampaignStatus,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignRender,
  type CampaignStatus,
  type MessageTemplate,
  type RecipientSelection,
  type RenderedRecipient,
} from '@netpro/core/src/campaigns';

export interface CampaignListOptions {
  status?: string;
  limit?: string;
  json?: boolean;
}

export interface CampaignCreateOptions {
  name?: string;
  subject?: string;
  body?: string;
  step?: string[];
  dailyLimit?: string;
  sendFrom?: string;
  contact?: string[];
  query?: string;
  company?: string;
  role?: string;
  location?: string;
  industry?: string;
  json?: boolean;
}

export interface CampaignShowOptions {
  json?: boolean;
}

export interface CampaignStatusOptions {
  json?: boolean;
}

export interface CampaignMarkOptions {
  force?: boolean;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Selectors — resolve a friendly reference to a concrete id.
// ---------------------------------------------------------------------------

/** Resolve a campaign by exact id, unique id-prefix, or unique name. */
export async function resolveCampaignId(
  conn: SqliteConn | PgConn,
  ref: string
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new CrmError('invalid_input', 'A campaign id (or unique prefix/name) is required.');
  }
  const { campaigns } = await listCampaigns(conn, { limit: 1000 });

  const exact = campaigns.find((c) => c.id === trimmed);
  if (exact) return exact.id;

  const byPrefix = campaigns.filter((c) => c.id.startsWith(trimmed));
  if (byPrefix.length === 1) return byPrefix[0]!.id;
  if (byPrefix.length > 1) {
    throw new CrmError(
      'invalid_input',
      `Campaign prefix "${trimmed}" is ambiguous (${byPrefix.length} matches). Use more characters.`
    );
  }

  const byName = campaigns.filter(
    (c) => c.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new CrmError(
      'invalid_input',
      `Campaign name "${trimmed}" matches ${byName.length} campaigns. Use the id instead.`
    );
  }

  throw new CrmError('not_found', `No campaign matches "${trimmed}".`);
}

/**
 * Resolve a recipient within a campaign by exact recipient id, unique
 * recipient-id prefix, or a contact reference (email / id / name) among the
 * campaign's recipients.
 */
export async function resolveRecipientId(
  conn: SqliteConn | PgConn,
  campaignId: string,
  ref: string
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new CrmError('invalid_input', 'A recipient id (or contact reference) is required.');
  }
  const render = await renderCampaign(conn, campaignId);
  if (!render) throw new CrmError('not_found', `No campaign with id "${campaignId}".`);
  const recipients = render.recipients;

  const exact = recipients.find((r) => r.id === trimmed);
  if (exact) return exact.id;

  const byPrefix = recipients.filter((r) => r.id.startsWith(trimmed));
  if (byPrefix.length === 1) return byPrefix[0]!.id;
  if (byPrefix.length > 1) {
    throw new CrmError(
      'invalid_input',
      `Recipient prefix "${trimmed}" is ambiguous (${byPrefix.length} matches).`
    );
  }

  // Fall back to a contact reference among this campaign's recipients.
  const lower = trimmed.toLowerCase();
  const byContact = recipients.filter(
    (r) =>
      r.contactId === trimmed ||
      r.contactEmail?.toLowerCase() === lower ||
      r.contactName.toLowerCase() === lower
  );
  if (byContact.length === 1) return byContact[0]!.id;
  if (byContact.length > 1) {
    throw new CrmError(
      'invalid_input',
      `Recipient "${trimmed}" matches ${byContact.length} contacts. Use the recipient id.`
    );
  }

  // Last resort: the shared contact resolver (partial name/email/id), then map
  // the resolved contact back to its recipient row in this campaign.
  try {
    const contact = await resolveContactRef(conn, trimmed);
    const viaContact = await findRecipientByContact(conn, campaignId, contact.id);
    if (viaContact) return viaContact.recipientId;
  } catch {
    // fall through to not_found
  }

  throw new CrmError('not_found', `No recipient matches "${trimmed}" in this campaign.`);
}

// ---------------------------------------------------------------------------
// Parsing helpers.
// ---------------------------------------------------------------------------

/** Parse a repeatable `--step DAYS:SUBJECT:BODY` (body may contain colons). */
export function parseStep(spec: string): { delayDays: number; subject: string; body: string } {
  const first = spec.indexOf(':');
  if (first < 0) {
    throw new CrmError('invalid_input', `--step expects "DAYS:SUBJECT:BODY", got "${spec}".`);
  }
  const second = spec.indexOf(':', first + 1);
  if (second < 0) {
    throw new CrmError('invalid_input', `--step expects "DAYS:SUBJECT:BODY", got "${spec}".`);
  }
  const delayDays = Number(spec.slice(0, first));
  if (!Number.isInteger(delayDays) || delayDays < 1) {
    throw new CrmError('invalid_input', `--step delay must be a whole number of days (got "${spec.slice(0, first)}").`);
  }
  return {
    delayDays,
    subject: spec.slice(first + 1, second),
    body: spec.slice(second + 1),
  };
}

/** Build a search filter from the create flags (only keys that were set). */
function searchFilterFromOptions(
  opts: CampaignCreateOptions
): RecipientSelection['search'] | null {
  const filter: NonNullable<RecipientSelection['search']> = {};
  if (opts.query) filter.query = opts.query;
  if (opts.company) filter.company = opts.company;
  if (opts.role) filter.role = opts.role;
  if (opts.location) filter.location = opts.location;
  if (opts.industry) filter.industry = opts.industry;
  return Object.keys(filter).length > 0 ? filter : null;
}

function buildSelection(opts: CampaignCreateOptions): RecipientSelection | undefined {
  if (opts.contact && opts.contact.length > 0) {
    return { contactIds: opts.contact };
  }
  const filter = searchFilterFromOptions(opts);
  if (filter) return { search: filter };
  return undefined;
}

// ---------------------------------------------------------------------------
// Renderers — human-readable output.
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function statusCounts(c: Campaign): string {
  return `${c.sent}/${c.totalRecipients} sent · ${c.replied} replied`;
}

export function renderCampaignLine(c: Campaign): string {
  const type = c.type === 'sequence' ? `sequence(${c.steps.length + 1})` : 'single';
  return `${shortId(c.id)}  ${c.status.padEnd(9)}  ${type.padEnd(12)}  ${statusCounts(c).padEnd(20)}  ${c.name}`;
}

export function renderRecipientLine(r: RenderedRecipient): string {
  const draft = r.draft ? ` — "${r.draft.subject}"` : '';
  const scheduled = r.scheduledAt ? ` (next ${r.scheduledAt.slice(0, 10)})` : '';
  return `${shortId(r.id)}  ${r.status.padEnd(9)}  ${r.contactName}${scheduled}${draft}`;
}

function renderCampaignDetail(render: CampaignRender, campaign: Campaign): string {
  const sequence: MessageTemplate[] = campaignSequence(campaign);
  const lines: string[] = [];
  lines.push(`${campaign.name}  [${shortId(campaign.id)}]`);
  lines.push(`status: ${campaign.status}   type: ${campaign.type}   daily limit: ${campaign.dailyLimit}`);
  lines.push(`recipients: ${campaign.totalRecipients}   sent: ${campaign.sent}   replied: ${campaign.replied}   bounced: ${campaign.bounced}`);
  if (campaign.sendFrom) lines.push(`send from: ${campaign.sendFrom}`);
  lines.push('');
  lines.push(`Sequence (${render.sequenceLength} message${render.sequenceLength === 1 ? '' : 's'}):`);
  sequence.forEach((m, i) => {
    const lead = i === 0 ? 'initial' : `step ${i} (+${campaign.steps[i - 1]!.delayDays}d)`;
    lines.push(`  ${i + 1}. [${lead}] ${m.subject}`);
    lines.push(`     ${m.body}`);
  });
  lines.push('');
  lines.push(`Today: ${render.sentToday} sent · ${render.dailyLimitRemaining} remaining under the daily limit`);
  lines.push('');
  lines.push('Recipients:');
  if (render.recipients.length === 0) {
    lines.push('  (none — add with `netpro campaign create … --contact <id>` or a search filter)');
  } else {
    for (const r of render.recipients) lines.push(`  ${renderRecipientLine(r)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Execute functions.
// ---------------------------------------------------------------------------

export async function executeCampaignList(
  opts: CampaignListOptions,
  conn: SqliteConn | PgConn,
  _now: Date = new Date()
): Promise<string> {
  const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 200);
  const { campaigns, total } = await listCampaigns(conn, {
    status: opts.status,
    limit,
  });
  if (opts.json) return JSON.stringify({ campaigns, total }, null, 2);
  if (campaigns.length === 0) {
    return opts.status
      ? `No ${opts.status} campaigns yet.`
      : 'No campaigns yet. Create one with `netpro campaign create`.';
  }
  const header = 'id        status     type          stats                 name';
  return [header, ...campaigns.map(renderCampaignLine), `\n${total} campaign${total === 1 ? '' : 's'} total.`].join('\n');
}

export async function executeCampaignCreate(
  opts: CampaignCreateOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  if (!opts.name) throw new CrmError('invalid_input', '--name is required.');
  if (!opts.subject) throw new CrmError('invalid_input', '--subject is required.');
  if (!opts.body) throw new CrmError('invalid_input', '--body is required.');

  const steps = (opts.step ?? []).map(parseStep);
  const selection = buildSelection(opts);

  const result = await createCampaign(
    conn,
    {
      name: opts.name,
      template: { subject: opts.subject, body: opts.body },
      steps,
      dailyLimit: opts.dailyLimit !== undefined ? Number(opts.dailyLimit) : undefined,
      sendFrom: opts.sendFrom,
      recipients: selection,
    },
    { now }
  );

  if (opts.json) return JSON.stringify(result, null, 2);
  const c = result.campaign;
  const bits = [`Created draft campaign "${c.name}" [${shortId(c.id)}]`];
  bits.push(`${c.type === 'sequence' ? `${c.steps.length + 1}-message sequence` : 'single message'}, daily limit ${c.dailyLimit}`);
  if (selection) {
    const detail = [`recipients: +${result.added} added`];
    if (result.skippedDuplicates > 0) detail.push(`${result.skippedDuplicates} duplicates skipped`);
    bits.push(detail.join(' · '));
  } else {
    bits.push('no recipients yet — add with `netpro campaign add-recipients` or a search filter at create time');
  }
  bits.push('\nActivate when ready: `netpro campaign activate ' + shortId(c.id) + '`');
  return bits.join('\n');
}

export async function executeCampaignAddRecipients(
  campaignRef: string,
  opts: CampaignCreateOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const selection = buildSelection(opts);
  if (!selection) {
    throw new CrmError('invalid_input', 'Provide --contact <id> (repeatable) or a search filter (--company/--role/--location/--industry/--query).');
  }
  const result = await addRecipients(conn, campaignId, selection, { now });
  if (opts.json) return JSON.stringify(result, null, 2);
  const bits = [`+${result.added} recipients added`];
  if (result.skippedDuplicates > 0) bits.push(`${result.skippedDuplicates} duplicates skipped`);
  return bits.join(' · ');
}

export async function executeCampaignShow(
  campaignRef: string,
  opts: CampaignShowOptions,
  conn: SqliteConn | PgConn,
  _now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const render = await renderCampaign(conn, campaignId);
  if (!render) throw new CrmError('not_found', `No campaign with id "${campaignId}".`);
  if (opts.json) return JSON.stringify(render, null, 2);
  return renderCampaignDetail(render, render.campaign);
}

export async function executeCampaignStatus(
  campaignRef: string,
  status: CampaignStatus,
  opts: CampaignStatusOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const updated = await setCampaignStatus(conn, campaignId, status, { now });
  if (opts.json) return JSON.stringify(updated, null, 2);
  return `✓ "${updated.name}" is now ${updated.status}.`;
}

export async function executeCampaignMarkSent(
  campaignRef: string,
  recipientRef: string,
  opts: CampaignMarkOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const recipientId = await resolveRecipientId(conn, campaignId, recipientRef);
  const result = await markRecipientSent(conn, campaignId, recipientId, {
    now,
    force: opts.force,
  });
  if (opts.json) return JSON.stringify(result, null, 2);
  const r = result.recipient;
  const next = r.status === 'scheduled' && r.scheduledAt
    ? ` Next message scheduled for ${r.scheduledAt.slice(0, 10)}.`
    : r.status === 'sent'
      ? ' Sequence complete.'
      : '';
  return `✓ Sent to ${r.contactName} — logged email_sent.${next} (${result.campaign.sent}/${result.campaign.totalRecipients} sent)`;
}

export async function executeCampaignMarkReplied(
  campaignRef: string,
  recipientRef: string,
  opts: CampaignMarkOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const recipientId = await resolveRecipientId(conn, campaignId, recipientRef);
  const result = await markRecipientReplied(conn, campaignId, recipientId, { now });
  if (opts.json) return JSON.stringify(result, null, 2);
  return `✓ Reply from ${result.recipient.contactName} recorded — drip cancelled. (${result.campaign.replied} replied)`;
}

export async function executeCampaignMarkSkipped(
  campaignRef: string,
  recipientRef: string,
  opts: CampaignMarkOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const campaignId = await resolveCampaignId(conn, campaignRef);
  const recipientId = await resolveRecipientId(conn, campaignId, recipientRef);
  const result = await markRecipientSkipped(conn, campaignId, recipientId, { now });
  if (opts.json) return JSON.stringify(result, null, 2);
  return `⊘ Skipped ${result.recipient.contactName} — no message will be drafted for this contact.`;
}

async function run(fn: (conn: SqliteConn | PgConn) => Promise<string>): Promise<void> {
  const { openDb } = await import('../db');
  try {
    console.log(await fn(await openDb()));
  } catch (e) {
    console.error(`netpro campaign: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerCampaignCommand(program: Command): void {
  const campaign = program
    .command('campaign')
    .description('Draft and manage batch outreach campaigns (NetPro drafts — you send)');

  campaign
    .command('list')
    .description('List campaigns')
    .option('--status <status>', `Filter by status (${CAMPAIGN_STATUSES.join(' | ')})`)
    .option('--limit <n>', 'Max rows (default 20, max 200)', '20')
    .option('--json', 'Print the result as JSON')
    .action((opts: CampaignListOptions) => run((conn) => executeCampaignList(opts, conn)));

  campaign
    .command('create')
    .description('Create a draft campaign (single message or drip sequence)')
    .option('--name <name>', 'Campaign name (required)')
    .option('--subject <text>', 'First message subject; merge vars allowed (required)')
    .option('--body <text>', 'First message body; merge vars allowed (required)')
    .option('--step <DAYS:SUBJECT:BODY>', 'Add a drip step (repeatable, max 5)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--daily-limit <n>', 'Max sends per day (default 50)')
    .option('--send-from <email>', 'The mailbox you send from (advisory only)')
    .option('--contact <id>', 'Recipient contact id (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--query <text>', 'Search snapshot: full-text query')
    .option('--company <company>', 'Search snapshot: company substring')
    .option('--role <role>', 'Search snapshot: role substring')
    .option('--location <location>', 'Search snapshot: location substring')
    .option('--industry <industry>', 'Search snapshot: industry substring')
    .option('--json', 'Print the result as JSON')
    .action((opts: CampaignCreateOptions) => run((conn) => executeCampaignCreate(opts, conn)));

  campaign
    .command('add-recipients <campaign>')
    .description('Add recipients to a campaign by id or search snapshot')
    .option('--contact <id>', 'Recipient contact id (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--query <text>', 'Search snapshot: full-text query')
    .option('--company <company>', 'Search snapshot: company substring')
    .option('--role <role>', 'Search snapshot: role substring')
    .option('--location <location>', 'Search snapshot: location substring')
    .option('--industry <industry>', 'Search snapshot: industry substring')
    .option('--json', 'Print the result as JSON')
    .action((ref: string, opts: CampaignCreateOptions) =>
      run((conn) => executeCampaignAddRecipients(ref, opts, conn))
    );

  campaign
    .command('show <campaign>')
    .description('Show a campaign: sequence, recipients, and each personalized draft')
    .option('--json', 'Print the result as JSON')
    .action((ref: string, opts: CampaignShowOptions) =>
      run((conn) => executeCampaignShow(ref, opts, conn))
    );

  for (const status of ['activate', 'pause', 'complete', 'archive'] as const) {
    const target: CampaignStatus =
      status === 'activate' ? 'active' : status === 'pause' ? 'paused' : status === 'complete' ? 'completed' : 'archived';
    campaign
      .command(`${status} <campaign>`)
      .description(`Move a campaign to "${target}"`)
      .option('--json', 'Print the result as JSON')
      .action((ref: string, opts: CampaignStatusOptions) =>
        run((conn) => executeCampaignStatus(ref, target, opts, conn))
      );
  }

  campaign
    .command('mark-sent <campaign> <recipient>')
    .description('Record that you sent a recipient\'s drafted message (logs an interaction)')
    .option('--force', 'Send even if it exceeds the daily limit')
    .option('--json', 'Print the result as JSON')
    .action((cref: string, rref: string, opts: CampaignMarkOptions) =>
      run((conn) => executeCampaignMarkSent(cref, rref, opts, conn))
    );

  campaign
    .command('mark-replied <campaign> <recipient>')
    .description('Record an inbound reply (logs an interaction and cancels the drip)')
    .option('--json', 'Print the result as JSON')
    .action((cref: string, rref: string, opts: CampaignMarkOptions) =>
      run((conn) => executeCampaignMarkReplied(cref, rref, opts, conn))
    );

  campaign
    .command('mark-skipped <campaign> <recipient>')
    .description('Opt a recipient out before sending (no interaction logged)')
    .option('--json', 'Print the result as JSON')
    .action((cref: string, rref: string, opts: CampaignMarkOptions) =>
      run((conn) => executeCampaignMarkSkipped(cref, rref, opts, conn))
    );
}
