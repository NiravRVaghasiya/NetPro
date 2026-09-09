// apps/cli/src/commands/track.ts
//
// `netpro track` — CRM interactions and follow-up reminders from the
// terminal. The blueprint's reference:
//
//   netpro track add "Jane Doe" --met-at "React Conf" --follow-up 7d
//   netpro track list --due-today
//   netpro track log "Jane Doe" --note "Discussed collab on OSS project"
//
// House pattern: exported execute*/render* functions take an injected conn
// and clock (testable without a process), and the commander actions are thin
// wrappers that open the database and print.
import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import { resolveContactRef } from "@netpro/core/src/ai";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  listInteractions,
  logInteraction,
  parseDurationMs,
  resolveFollowUpId,
  snoozeFollowUp,
  startOfUtcDay,
  DAY_MS,
  type FollowUpRow,
  type FollowUpView,
  type InteractionWithContact,
} from "@netpro/core/src/crm";

export interface TrackLogOptions {
  type?: string;
  note?: string;
  subject?: string;
  channel?: string;
  direction?: string;
  at?: string;
  followUp?: string | boolean;
  reason?: string;
  json?: boolean;
}

export interface TrackAddOptions {
  metAt?: string;
  at?: string;
  followUp?: string | boolean;
  reason?: string;
  channel?: string;
  json?: boolean;
}

export interface TrackListOptions {
  dueToday?: boolean;
  overdue?: boolean;
  upcoming?: boolean;
  recent?: boolean;
  all?: boolean;
  contact?: string;
  limit?: string;
  json?: boolean;
}

export interface TrackSnoozeOptions {
  for?: string;
  until?: string;
  json?: boolean;
}

export interface TrackDoneOptions {
  json?: boolean;
}

const DEFAULT_FOLLOW_UP = "7d";

/** Commander passes `--follow-up` (optional value) as undefined | true | string. */
export function followUpDurationMs(
  flag: string | boolean | undefined,
): number | null {
  if (flag === undefined || flag === false) return null;
  const duration = flag === true ? DEFAULT_FOLLOW_UP : String(flag);
  return parseDurationMs(duration);
}

/** The list sections are mutually exclusive; absent all → pending follow-ups. */
export function selectedListSection(
  opts: TrackListOptions,
): "due-today" | "overdue" | "upcoming" | "recent" | "all" | "pending" {
  const sections = [
    opts.dueToday,
    opts.overdue,
    opts.upcoming,
    opts.recent,
    opts.all,
  ].filter(Boolean);
  if (sections.length > 1) {
    throw new Error(
      "--due-today, --overdue, --upcoming, --recent, and --all are mutually exclusive — pick one, or omit all for pending follow-ups",
    );
  }
  if (opts.dueToday) return "due-today";
  if (opts.overdue) return "overdue";
  if (opts.upcoming) return "upcoming";
  if (opts.recent) return "recent";
  if (opts.all) return "all";
  return "pending";
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--limit must be a positive number, got "${value}"`);
  }
  return Math.min(Math.floor(n), 200);
}

/** `2026-09-13` — the UTC day of an ISO timestamp. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** "today" / "tomorrow" / "yesterday" / "in 3d" / "2d ago" — UTC-day granularity. */
export function relativeDay(iso: string, now: Date): string {
  const target = startOfUtcDay(new Date(iso)).getTime();
  const today = startOfUtcDay(now).getTime();
  const diff = Math.round((target - today) / DAY_MS);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff}d` : `${-diff}d ago`;
}

function excerpt(text: string | null | undefined, max = 60): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function renderFollowUpLine(f: FollowUpRow, now: Date): string {
  const overdue = new Date(f.effectiveDueAt) < startOfUtcDay(now);
  const marker = overdue
    ? "⚠"
    : relativeDay(f.effectiveDueAt, now) === "today"
      ? "→"
      : "·";
  const reason = f.reason ? ` · "${excerpt(f.reason, 40)}"` : "";
  const recurring =
    f.recurring && f.recurrenceRule ? ` · every ${f.recurrenceRule}` : "";
  const company = f.contactCompany ? ` (${f.contactCompany})` : "";
  return `  ${marker} ${f.contactName}${company} — due ${utcDay(f.effectiveDueAt)} (${relativeDay(f.effectiveDueAt, now)})${reason}${recurring}  [${f.id.slice(0, 8)}]`;
}

export function renderInteractionLine(
  i: InteractionWithContact,
  now: Date,
): string {
  const detail = excerpt(i.subject ?? i.content);
  const direction = i.direction
    ? ` ${i.direction === "outbound" ? "→" : "←"}`
    : "";
  return `  ${utcDay(i.occurredAt)} (${relativeDay(i.occurredAt, now)}) · ${i.type}${direction} · ${i.contactName}${detail ? ` — "${detail}"` : ""}`;
}

function summaryLine(counts: {
  overdue: number;
  dueToday: number;
  upcoming: number;
}): string {
  return `Follow-ups — ${counts.overdue} overdue · ${counts.dueToday} due today · ${counts.upcoming} upcoming`;
}

async function resolveContactId(
  conn: SqliteConn | PgConn,
  selector: string | undefined,
  scope?: WorkspaceScope,
): Promise<string | undefined> {
  if (!selector) return undefined;
  return (await resolveContactRef(conn, selector, scope)).id;
}

export async function executeTrackLog(
  selector: string,
  opts: TrackLogOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const contact = await resolveContactRef(conn, selector, scope);
  const followUpMs = followUpDurationMs(opts.followUp);

  const result = await logInteraction(
    conn,
    {
      contactId: contact.id,
      type: opts.type ?? "note",
      content: opts.note,
      subject: opts.subject,
      channel: opts.channel,
      direction: opts.direction,
      occurredAt: opts.at,
    },
    { now },
    scope,
  );

  let followUp: FollowUpRow | null = null;
  if (followUpMs !== null) {
    followUp = await createFollowUp(
      conn,
      { contactId: contact.id, dueInMs: followUpMs, reason: opts.reason },
      { now },
      scope,
    );
  }

  if (opts.json) {
    return JSON.stringify(
      { interaction: result.interaction, stats: result.stats, followUp },
      null,
      2,
    );
  }

  const channel = result.interaction.channel
    ? ` via ${result.interaction.channel}`
    : "";
  const when =
    result.interaction.occurredAt === now.toISOString()
      ? ""
      : ` on ${utcDay(result.interaction.occurredAt)}`;
  const lines = [
    `✓ Logged ${result.interaction.type} with ${contact.fullName}${channel}${when} — ` +
      `score ${result.stats.relationshipScore.toFixed(2)} · ${result.stats.interactionCount} interaction${result.stats.interactionCount === 1 ? "" : "s"}.`,
  ];
  if (followUp) {
    lines.push(
      `  Follow-up due ${utcDay(followUp.effectiveDueAt)} (${relativeDay(followUp.effectiveDueAt, now)})${followUp.reason ? ` — "${followUp.reason}"` : ""}  [${followUp.id.slice(0, 8)}]`,
    );
  }
  return lines.join("\n");
}

export async function executeTrackAdd(
  selector: string,
  opts: TrackAddOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const metAt = opts.metAt?.trim();
  if (!metAt) {
    throw new Error(
      '--met-at is required: where or how you met, e.g. --met-at "React Conf"',
    );
  }
  const contact = await resolveContactRef(conn, selector, scope);
  const followUpMs = followUpDurationMs(opts.followUp);

  const result = await logInteraction(
    conn,
    {
      contactId: contact.id,
      type: "meeting",
      channel: opts.channel ?? "in_person",
      content: metAt,
      occurredAt: opts.at,
    },
    { now },
    scope,
  );

  let followUp: FollowUpRow | null = null;
  if (followUpMs !== null) {
    followUp = await createFollowUp(
      conn,
      {
        contactId: contact.id,
        dueInMs: followUpMs,
        reason: opts.reason ?? `Follow up from ${metAt}`,
      },
      { now },
      scope,
    );
  }

  if (opts.json) {
    return JSON.stringify(
      { interaction: result.interaction, stats: result.stats, followUp },
      null,
      2,
    );
  }

  const lines = [`✓ Met ${contact.fullName} — "${metAt}" logged as a meeting.`];
  if (followUp) {
    lines.push(
      `  Follow-up due ${utcDay(followUp.effectiveDueAt)} (${relativeDay(followUp.effectiveDueAt, now)}) — "${followUp.reason}"  [${followUp.id.slice(0, 8)}]`,
    );
  } else {
    lines.push("  No follow-up scheduled — add one with --follow-up 7d.");
  }
  return lines.join("\n");
}

export async function executeTrackList(
  opts: TrackListOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const section = selectedListSection(opts);
  const limit = parseLimit(opts.limit);
  const contactId = await resolveContactId(conn, opts.contact, scope);

  if (section === "recent") {
    const interactions = await listInteractions(
      conn,
      { contactId, limit },
      scope,
    );
    if (opts.json) return JSON.stringify(interactions, null, 2);
    if (interactions.length === 0) {
      return 'No interactions logged yet — try: netpro track log "Jane Doe" --note "Discussed collab on OSS project"';
    }
    return [
      `Recent interactions (${interactions.length}):`,
      ...interactions.map((i) => renderInteractionLine(i, now)),
    ].join("\n");
  }

  const view: FollowUpView = section === "pending" ? "pending" : section;
  const summary = await listFollowUps(
    conn,
    { view, contactId, limit, now },
    scope,
  );
  if (opts.json) return JSON.stringify(summary, null, 2);

  if (summary.followUps.length === 0) {
    if (section === "due-today") {
      return `Nothing due today. 🎉\n${summaryLine(summary.counts)}`;
    }
    return `No follow-ups here.\n${summaryLine(summary.counts)}\nSchedule one with: netpro track add "Jane Doe" --met-at "React Conf" --follow-up 7d`;
  }

  const title =
    section === "pending"
      ? "Pending follow-ups"
      : section === "all"
        ? "All follow-ups"
        : `Follow-ups — ${section}`;
  return [
    `${title} (${summary.followUps.length}):`,
    summaryLine(summary.counts),
    ...summary.followUps.map((f) => renderFollowUpLine(f, now)),
    "",
    "Complete one with: netpro track done <id>",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export async function executeTrackDone(
  idOrPrefix: string,
  opts: TrackDoneOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const id = await resolveFollowUpId(conn, idOrPrefix, scope);
  const result = await completeFollowUp(conn, id, { now }, scope);

  if (opts.json) return JSON.stringify(result, null, 2);

  const lines = [`✓ Completed follow-up for ${result.completed.contactName}.`];
  if (result.next) {
    lines.push(
      `  Recurring — next due ${utcDay(result.next.effectiveDueAt)} (${relativeDay(result.next.effectiveDueAt, now)})  [${result.next.id.slice(0, 8)}]`,
    );
  }
  return lines.join("\n");
}

export async function executeTrackSnooze(
  idOrPrefix: string,
  opts: TrackSnoozeOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const id = await resolveFollowUpId(conn, idOrPrefix, scope);
  const { for: forDuration, until } = opts;
  if (!forDuration && !until) {
    throw new Error(
      "Snooze needs a target: --for 3d (relative) or --until 2026-10-01 (absolute).",
    );
  }
  const input = until
    ? // A bare date (2026-10-01) means that day at 09:00 UTC — a usable
      // morning reminder rather than midnight.
      {
        untilIso: /^\d{4}-\d{2}-\d{2}$/.test(until.trim())
          ? `${until.trim()}T09:00:00Z`
          : until,
      }
    : { forMs: parseDurationMs(forDuration!) };
  const snoozed = await snoozeFollowUp(conn, id, input, { now }, scope);

  if (opts.json) return JSON.stringify(snoozed, null, 2);
  return `⏸ Snoozed ${snoozed.contactName}'s follow-up until ${utcDay(snoozed.effectiveDueAt)} (${relativeDay(snoozed.effectiveDueAt, now)}).`;
}

export async function executeTrackCancel(
  idOrPrefix: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const id = await resolveFollowUpId(conn, idOrPrefix, scope);
  const cancelled = await cancelFollowUp(conn, id, { now }, scope);
  if (opts.json) return JSON.stringify(cancelled, null, 2);
  return `✗ Cancelled follow-up for ${cancelled.contactName} (${utcDay(cancelled.dueAt)}).`;
}

async function run(
  cmd: Command,
  fn: (conn: SqliteConn | PgConn, scope?: WorkspaceScope) => Promise<string>,
): Promise<void> {
  const { openDb, resolveCliScope } = await import("../db");
  try {
    const conn = await openDb();
    const scope = await resolveCliScope(cmd, conn);
    console.log(await fn(conn, scope));
  } catch (e) {
    console.error(`netpro track: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerTrackCommand(program: Command): void {
  const track = program
    .command("track")
    .description("Track CRM interactions and follow-ups");

  track
    .command("log <contact>")
    .description(
      "Log an interaction with a contact (email, meeting, call, note…)",
    )
    .option("--type <type>", 'Interaction type (default "note")', "note")
    .option(
      "--note <text>",
      "What happened (stored as the interaction content)",
    )
    .option("--subject <text>", "Short subject line (e.g. the email subject)")
    .option(
      "--channel <channel>",
      "email | linkedin | twitter | in_person | phone | other",
    )
    .option("--direction <dir>", "inbound | outbound (defaults per type)")
    .option(
      "--at <iso>",
      "When it happened — ISO date/time; backdating allowed (default now)",
    )
    .option(
      "--follow-up [duration]",
      `Also schedule a follow-up (24h/7d/2w; default ${DEFAULT_FOLLOW_UP})`,
    )
    .option("--reason <text>", "Why the follow-up is needed")
    .option("--json", "Print the result as JSON")
    .action((contact: string, opts: TrackLogOptions) =>
      run(track, (conn, scope) =>
        executeTrackLog(contact, opts, conn, new Date(), scope),
      ),
    );

  track
    .command("add <contact>")
    .description("Record where you met someone and schedule the follow-up")
    .option(
      "--met-at <text>",
      'Where/how you met, e.g. "React Conf" (required)',
    )
    .option("--at <iso>", "When you met (default now; backdating allowed)")
    .option(
      "--follow-up [duration]",
      `Follow-up window (24h/7d/2w; default ${DEFAULT_FOLLOW_UP} when the flag is given)`,
    )
    .option("--reason <text>", "Why the follow-up is needed")
    .option("--channel <channel>", "Meeting channel (default in_person)")
    .option("--json", "Print the result as JSON")
    .action((contact: string, opts: TrackAddOptions) =>
      run(track, (conn, scope) =>
        executeTrackAdd(contact, opts, conn, new Date(), scope),
      ),
    );

  track
    .command("list")
    .description("List follow-ups (default: pending) or recent interactions")
    .option("--due-today", "Only follow-ups due today")
    .option("--overdue", "Only overdue follow-ups")
    .option("--upcoming", "Only future follow-ups")
    .option("--recent", "Recent interactions instead of follow-ups")
    .option("--all", "Every follow-up, including completed/cancelled")
    .option(
      "--contact <selector>",
      "Filter to one contact (email, id, or full name)",
    )
    .option("--limit <n>", "Max rows (default 20, max 200)", "20")
    .option("--json", "Print the result as JSON")
    .action((opts: TrackListOptions) =>
      run(track, (conn, scope) =>
        executeTrackList(opts, conn, new Date(), scope),
      ),
    );

  track
    .command("done <followUpId>")
    .description("Complete a follow-up (full id or unique prefix)")
    .option("--json", "Print the result as JSON")
    .action((id: string, opts: TrackDoneOptions) =>
      run(track, (conn, scope) =>
        executeTrackDone(id, opts, conn, new Date(), scope),
      ),
    );

  track
    .command("snooze <followUpId>")
    .description("Push a follow-up into the future")
    .option("--for <duration>", "Relative snooze, e.g. 3d or 12h")
    .option("--until <date>", "Absolute snooze target, e.g. 2026-10-01")
    .option("--json", "Print the result as JSON")
    .action((id: string, opts: TrackSnoozeOptions) =>
      run(track, (conn, scope) =>
        executeTrackSnooze(id, opts, conn, new Date(), scope),
      ),
    );

  track
    .command("cancel <followUpId>")
    .description("Cancel a follow-up without completing it")
    .option("--json", "Print the result as JSON")
    .action((id: string, opts: { json?: boolean }) =>
      run(track, (conn, scope) =>
        executeTrackCancel(id, opts, conn, new Date(), scope),
      ),
    );
}
