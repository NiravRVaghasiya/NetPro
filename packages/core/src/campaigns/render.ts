// packages/core/src/campaigns/render.ts
//
// Rendering and the human-in-the-loop send ledger. `renderCampaign` turns
// the campaign + recipients into per-recipient personalized drafts with the
// daily-limit meter. `markRecipientSent` is the pivotal mutation: it enforces
// the daily limit, records the confirmed send as a real `email_sent`
// interaction through the CRM module (so scoring, stats, and analytics stay
// single-sourced), and schedules the next drip step as advice.

import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { writeActivityLog } from "../crm/activity";
import { logInteraction } from "../crm/interactions";
import {
  CrmError,
  resolveNow,
  startOfUtcDay,
  DAY_MS,
  type CrmOptions,
} from "../crm/types";
import { workspacePredicate, type WorkspaceScope } from "../workspaces/scope";
import {
  getCampaign,
  parseJsonColumn,
  refreshCampaignStats,
} from "./repository";
import { contactToTemplateVars, renderMessage } from "./template";
import {
  campaignSequence,
  type Campaign,
  type MessageTemplate,
  type RecipientStatus,
} from "./types";

export interface RenderedRecipient {
  id: string;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  company: string | null;
  status: RecipientStatus;
  /** Index of the next message to send within [template, ...steps]. */
  currentStep: number;
  sequenceLength: number;
  /** Personalized draft of the next message, or null when nothing is left to send. */
  draft: MessageTemplate | null;
  /** When the next message becomes due (drip advice; no worker enforces it). */
  scheduledAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  /** The contact was soft-deleted after being added — sends are blocked. */
  contactDeleted: boolean;
}

export interface CampaignRender {
  campaign: Campaign;
  recipients: RenderedRecipient[];
  sequenceLength: number;
  /** Recipients with a send recorded today (UTC). */
  sentToday: number;
  dailyLimitRemaining: number;
}

interface RecipientJoinRow {
  id: string;
  contactId: string;
  status: string | null;
  currentStep: number | null;
  personalizedVars: unknown;
  scheduledAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string | null;
  email: string | null;
  headline: string | null;
  location: string | null;
  industry: string | null;
  contactDeletedAt: string | null;
}

async function selectRecipientRows(
  conn: SqliteConn | PgConn,
  campaignId: string,
  recipientId?: string,
  scope?: WorkspaceScope,
): Promise<RecipientJoinRow[]> {
  // Drizzle's typed builders need dialect-narrowed tables; the query itself
  // is one portable join (recipient → contact).
  if (conn.dialect === "sqlite") {
    const r = conn.schema.campaignRecipients;
    const c = conn.schema.contacts;
    const rows = await conn.db
      .select({
        id: r.id,
        contactId: r.contactId,
        status: r.status,
        currentStep: r.currentStep,
        personalizedVars: r.personalizedVars,
        scheduledAt: r.scheduledAt,
        sentAt: r.sentAt,
        repliedAt: r.repliedAt,
        fullName: c.fullName,
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.company,
        role: c.role,
        email: c.email,
        headline: c.headline,
        location: c.location,
        industry: c.industry,
        contactDeletedAt: c.deletedAt,
      })
      .from(r)
      .innerJoin(c, eq(r.contactId, c.id))
      .where(
        and(
          recipientId
            ? and(eq(r.campaignId, campaignId), eq(r.id, recipientId))
            : eq(r.campaignId, campaignId),
          workspacePredicate(scope, r.workspaceId),
        ),
      )
      .orderBy(sql`${r.id} ASC`);
    return rows as RecipientJoinRow[];
  }
  const r = conn.schema.campaignRecipients;
  const c = conn.schema.contacts;
  const rows = await conn.db
    .select({
      id: r.id,
      contactId: r.contactId,
      status: r.status,
      currentStep: r.currentStep,
      personalizedVars: r.personalizedVars,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      repliedAt: r.repliedAt,
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      role: c.role,
      email: c.email,
      headline: c.headline,
      location: c.location,
      industry: c.industry,
      contactDeletedAt: c.deletedAt,
    })
    .from(r)
    .innerJoin(c, eq(r.contactId, c.id))
    .where(
      and(
        recipientId
          ? and(eq(r.campaignId, campaignId), eq(r.id, recipientId))
          : eq(r.campaignId, campaignId),
        workspacePredicate(scope, r.workspaceId),
      ),
    )
    .orderBy(sql`${r.id} ASC`);
  return rows as RecipientJoinRow[];
}

function toRenderedRecipient(
  row: RecipientJoinRow,
  sequence: MessageTemplate[],
): RenderedRecipient {
  const status: RecipientStatus = (
    ["pending", "scheduled", "sent", "replied", "skipped"] as RecipientStatus[]
  ).includes(row.status as RecipientStatus)
    ? (row.status as RecipientStatus)
    : "pending";
  const currentStep = Math.max(row.currentStep ?? 0, 0);
  const vars = contactToTemplateVars(
    {
      fullName: row.fullName,
      firstName: row.firstName,
      lastName: row.lastName,
      company: row.company,
      role: row.role,
      email: row.email,
      headline: row.headline,
      location: row.location,
      industry: row.industry,
    },
    parseJsonColumn<Record<string, unknown> | null>(row.personalizedVars, null),
  );

  let draft: MessageTemplate | null = null;
  if (
    (status === "pending" || status === "scheduled") &&
    currentStep < sequence.length &&
    row.contactDeletedAt === null
  ) {
    draft = renderMessage(sequence[currentStep]!, vars);
  }

  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.fullName,
    contactEmail: row.email,
    company: row.company,
    status,
    currentStep,
    sequenceLength: sequence.length,
    draft,
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    repliedAt: row.repliedAt,
    contactDeleted: row.contactDeletedAt !== null,
  };
}

/** Recipients whose send was confirmed today (UTC day). */
export async function countSentToday(
  conn: SqliteConn | PgConn,
  campaignId: string,
  now: Date,
  scope?: WorkspaceScope,
): Promise<number> {
  const fromIso = startOfUtcDay(now).toISOString();
  const toIso = new Date(startOfUtcDay(now).getTime() + DAY_MS).toISOString();
  if (conn.dialect === "sqlite") {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(r)
      .where(
        and(
          eq(r.campaignId, campaignId),
          isNotNull(r.sentAt),
          gte(r.sentAt, fromIso),
          lt(r.sentAt, toIso),
          workspacePredicate(scope, r.workspaceId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
  const r = conn.schema.campaignRecipients;
  const rows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(r)
    .where(
      and(
        eq(r.campaignId, campaignId),
        isNotNull(r.sentAt),
        gte(r.sentAt, fromIso),
        lt(r.sentAt, toIso),
        workspacePredicate(scope, r.workspaceId),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export interface RenderCampaignOptions extends CrmOptions {
  limit?: number;
}

/**
 * The campaign detail aggregate: rendered drafts per recipient plus the
 * daily-limit meter. Returns null for unknown campaigns.
 */
export async function renderCampaign(
  conn: SqliteConn | PgConn,
  campaignId: string,
  opts: RenderCampaignOptions = {},
  scope?: WorkspaceScope,
): Promise<CampaignRender | null> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, campaignId, scope);
  if (!campaign) return null;

  const sequence = campaignSequence(campaign);
  const rows = await selectRecipientRows(conn, campaign.id, undefined, scope);
  const recipients = rows
    .map((row) => toRenderedRecipient(row, sequence))
    .slice(
      0,
      Math.min(
        Math.max(opts.limit ?? Number.MAX_SAFE_INTEGER, 1),
        Number.MAX_SAFE_INTEGER,
      ),
    );

  const sentToday = await countSentToday(conn, campaign.id, now, scope);
  return {
    campaign,
    recipients,
    sequenceLength: sequence.length,
    sentToday,
    dailyLimitRemaining: Math.max(0, campaign.dailyLimit - sentToday),
  };
}

async function selectRecipientRow(
  conn: SqliteConn | PgConn,
  campaignId: string,
  recipientId: string,
  scope?: WorkspaceScope,
): Promise<RecipientJoinRow | null> {
  const rows = await selectRecipientRows(conn, campaignId, recipientId, scope);
  return rows[0] ?? null;
}

export interface MarkSentOptions extends CrmOptions {
  /** Override the daily limit — for the person who set it, and regrets it. */
  force?: boolean;
}

export interface MarkSentResult {
  recipient: RenderedRecipient;
  interactionId: string;
  campaign: Campaign;
}

/**
 * Record a human-confirmed send of the recipient's current step.
 *
 * Guardrails, in order: the campaign must be active (draft campaigns don't
 * track sends — activate first); the recipient must still be in the running
 * (pending/scheduled); the sequence must have a message left; and the
 * campaign's daily limit must not be reached (unless forced). The send is
 * logged as a real `email_sent` interaction through the CRM module, then the
 * next drip step is scheduled as advice and stats are refreshed.
 */
export async function markRecipientSent(
  conn: SqliteConn | PgConn,
  campaignId: string,
  recipientId: string,
  opts: MarkSentOptions = {},
  scope?: WorkspaceScope,
): Promise<MarkSentResult> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, campaignId, scope);
  if (!campaign)
    throw new CrmError("not_found", `No campaign with id "${campaignId}".`);

  const row = await selectRecipientRow(conn, campaignId, recipientId, scope);
  if (!row) {
    throw new CrmError(
      "not_found",
      `Recipient "${recipientId}" is not part of campaign "${campaign.name}".`,
    );
  }
  if (row.contactDeletedAt !== null) {
    throw new CrmError(
      "conflict",
      `${row.fullName} was deleted — skip this recipient instead of sending.`,
    );
  }
  if (campaign.status !== "active") {
    throw new CrmError(
      "conflict",
      `Campaign "${campaign.name}" is ${campaign.status} — activate it before recording sends.`,
    );
  }

  const status = (row.status ?? "pending") as RecipientStatus;
  if (status !== "pending" && status !== "scheduled") {
    const hint =
      status === "replied"
        ? "They already replied — the sequence is over."
        : status === "skipped"
          ? "This recipient was skipped."
          : "The whole sequence was already sent.";
    throw new CrmError(
      "conflict",
      `Recipient "${row.fullName}" is ${status}. ${hint}`,
    );
  }

  const sequence = campaignSequence(campaign);
  const currentStep = Math.max(row.currentStep ?? 0, 0);
  if (currentStep >= sequence.length) {
    throw new CrmError(
      "conflict",
      `Recipient "${row.fullName}" has finished the sequence.`,
    );
  }

  const sentToday = await countSentToday(conn, campaignId, now, scope);
  if (!opts.force && sentToday >= campaign.dailyLimit) {
    throw new CrmError(
      "conflict",
      `Daily limit reached for "${campaign.name}" (${sentToday}/${campaign.dailyLimit} sent today). ` +
        "Try again tomorrow, raise the limit, or override with force.",
    );
  }

  const vars = contactToTemplateVars(
    {
      fullName: row.fullName,
      firstName: row.firstName,
      lastName: row.lastName,
      company: row.company,
      role: row.role,
      email: row.email,
      headline: row.headline,
      location: row.location,
      industry: row.industry,
    },
    parseJsonColumn<Record<string, unknown> | null>(row.personalizedVars, null),
  );
  const message = renderMessage(sequence[currentStep]!, vars);

  const nextStep = currentStep + 1;
  const finished = nextStep >= sequence.length;
  const scheduledAt = finished
    ? null
    : new Date(
        now.getTime() + campaign.steps[nextStep - 1]!.delayDays * DAY_MS,
      ).toISOString();
  const nextStatus: RecipientStatus = finished ? "sent" : "scheduled";

  const updates = {
    status: nextStatus,
    currentStep: nextStep,
    sentAt: now.toISOString(),
    scheduledAt,
    errorMessage: null,
  };
  if (conn.dialect === "sqlite") {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  } else {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  }

  // A confirmed send IS a real send: log it through the CRM module so the
  // contact's stats, relationship score, and the activity log stay true.
  const { interaction } = await logInteraction(
    conn,
    {
      contactId: row.contactId,
      type: "email_sent",
      direction: "outbound",
      channel: "email",
      subject: message.subject.slice(0, 200),
      content: message.body,
      campaignId: campaign.id,
      occurredAt: now,
    },
    { now },
    scope,
  );

  await refreshCampaignStats(conn, campaignId, now, scope);
  await writeActivityLog(
    conn,
    {
      action: "campaign.message_sent",
      entityType: "campaign",
      entityId: campaignId,
      metadata: {
        recipientId: row.id,
        contactId: row.contactId,
        step: currentStep,
        interactionId: interaction.id,
      },
    },
    scope,
  );

  const updatedRow: RecipientJoinRow = { ...row, ...updates };
  return {
    recipient: toRenderedRecipient(updatedRow, sequence),
    interactionId: interaction.id,
    campaign: (await getCampaign(conn, campaignId, scope))!,
  };
}

export interface MarkActionResult {
  recipient: RenderedRecipient;
  campaign: Campaign;
  interactionId: string | null;
}

/**
 * Record a reply: logs an inbound `email_received` interaction and cancels
 * the remaining drip for this recipient — continuing to follow up with
 * someone who answered is exactly what the blueprint's `no_reply` condition
 * prevents.
 */
export async function markRecipientReplied(
  conn: SqliteConn | PgConn,
  campaignId: string,
  recipientId: string,
  opts: CrmOptions = {},
  scope?: WorkspaceScope,
): Promise<MarkActionResult> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, campaignId, scope);
  if (!campaign)
    throw new CrmError("not_found", `No campaign with id "${campaignId}".`);
  const row = await selectRecipientRow(conn, campaignId, recipientId, scope);
  if (!row) {
    throw new CrmError(
      "not_found",
      `Recipient "${recipientId}" is not part of campaign "${campaign.name}".`,
    );
  }
  const status = (row.status ?? "pending") as RecipientStatus;
  if (status !== "sent" && status !== "scheduled") {
    throw new CrmError(
      "conflict",
      status === "replied"
        ? `A reply from "${row.fullName}" is already recorded.`
        : `Recipient "${row.fullName}" is ${status} — replies can only be recorded after a send.`,
    );
  }

  const updates = {
    status: "replied" as const,
    repliedAt: now.toISOString(),
    scheduledAt: null,
  };
  if (conn.dialect === "sqlite") {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  } else {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  }

  // Subject of the last message sent, prefixed — best-effort context for the
  // inbound interaction (the actual reply text is not captured in v1.5).
  const sequence = campaignSequence(campaign);
  const lastSentIndex = Math.min(
    Math.max((row.currentStep ?? 1) - 1, 0),
    sequence.length - 1,
  );
  const vars = contactToTemplateVars({
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    role: row.role,
    email: row.email,
    headline: row.headline,
    location: row.location,
    industry: row.industry,
  });
  const lastSubject = renderMessage(sequence[lastSentIndex]!, vars).subject;

  const { interaction } = await logInteraction(
    conn,
    {
      contactId: row.contactId,
      type: "email_received",
      direction: "inbound",
      channel: "email",
      subject: `Re: ${lastSubject}`.slice(0, 200),
      campaignId: campaign.id,
      occurredAt: now,
    },
    { now },
    scope,
  );

  await refreshCampaignStats(conn, campaignId, now, scope);
  await writeActivityLog(
    conn,
    {
      action: "campaign.replied",
      entityType: "campaign",
      entityId: campaignId,
      metadata: {
        recipientId: row.id,
        contactId: row.contactId,
        interactionId: interaction.id,
      },
    },
    scope,
  );

  return {
    recipient: toRenderedRecipient({ ...row, ...updates }, sequence),
    campaign: (await getCampaign(conn, campaignId, scope))!,
    interactionId: interaction.id,
  };
}

/**
 * Manually opt one recipient out: nothing was sent, so — unlike a confirmed
 * send — nothing is logged as an interaction.
 */
export async function markRecipientSkipped(
  conn: SqliteConn | PgConn,
  campaignId: string,
  recipientId: string,
  opts: CrmOptions = {},
  scope?: WorkspaceScope,
): Promise<MarkActionResult> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, campaignId, scope);
  if (!campaign)
    throw new CrmError("not_found", `No campaign with id "${campaignId}".`);
  const row = await selectRecipientRow(conn, campaignId, recipientId, scope);
  if (!row) {
    throw new CrmError(
      "not_found",
      `Recipient "${recipientId}" is not part of campaign "${campaign.name}".`,
    );
  }
  const status = (row.status ?? "pending") as RecipientStatus;
  if (status !== "pending" && status !== "scheduled") {
    throw new CrmError(
      "conflict",
      `Recipient "${row.fullName}" is ${status} — only pending or scheduled recipients can be skipped.`,
    );
  }

  const updates = {
    status: "skipped" as const,
    scheduledAt: null,
    errorMessage: null,
  };
  if (conn.dialect === "sqlite") {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  } else {
    await conn.db
      .update(conn.schema.campaignRecipients)
      .set(updates)
      .where(eq(conn.schema.campaignRecipients.id, row.id));
  }

  await refreshCampaignStats(conn, campaignId, now, scope);
  await writeActivityLog(
    conn,
    {
      action: "campaign.skipped",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { recipientId: row.id, contactId: row.contactId },
    },
    scope,
  );

  return {
    recipient: toRenderedRecipient(
      { ...row, ...updates },
      campaignSequence(campaign),
    ),
    campaign: (await getCampaign(conn, campaignId, scope))!,
    interactionId: null,
  };
}

/** Find the recipient row for a contact within a campaign (CLI selectors). */
export async function findRecipientByContact(
  conn: SqliteConn | PgConn,
  campaignId: string,
  contactId: string,
  scope?: WorkspaceScope,
): Promise<{ recipientId: string } | null> {
  if (conn.dialect === "sqlite") {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.campaignId, campaignId),
          eq(r.contactId, contactId),
          workspacePredicate(scope, r.workspaceId),
        ),
      );
    return rows[0] ? { recipientId: rows[0].id } : null;
  }
  const r = conn.schema.campaignRecipients;
  const rows = await conn.db
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(r.campaignId, campaignId),
        eq(r.contactId, contactId),
        workspacePredicate(scope, r.workspaceId),
      ),
    );
  return rows[0] ? { recipientId: rows[0].id } : null;
}
