// apps/cli/src/commands/events.ts
//
// `netpro events` — the v2.0 Phase 6 event matcher from the terminal.
//   netpro events list [--query] [--upcoming] [--limit]
//   netpro events show <event>                  overlap: who in your network went
//   netpro events add <name> [--location] [--starts] [--ends]
//   netpro events import <csv> [--dry-run] [--review] [--no-edges]
//   netpro events match <event> [--apply] [--review]
//   netpro events link <event> <contact> [--role]
//   netpro events unlink <event> <contact>
//   netpro events recommend [--limit]
//   netpro events rm <event>
//
// Rendering and flag validation only — parsing, matching, ranking and every
// write live in @netpro/core/src/events so the web app answers identically.
// Two rules the output makes visible: an imported attendee list is evidence of
// attendance (edges land `pending` for you to confirm), and an ambiguous line
// is never resolved by guessing.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import type { SqliteConn, PgConn } from "@netpro/db";
import { resolveContactRef } from "@netpro/core/src/ai";
import {
  EventError,
  countEvents,
  eventsStatus,
  getEvent,
  importEvents,
  linkAttendee,
  listEvents,
  matchEventAttendees,
  recommendEvents,
  removeEvent,
  resolveEventRef,
  unlinkAttendee,
  upsertEvent,
  type EventDetail,
  type EventRecommendation,
  type EventSummary,
  type ImportEventsSummary,
  type MatchEventResult,
} from "@netpro/core/src/events";
import { relativeDay, utcDay } from "./track";

export interface EventsListOptions {
  query?: string;
  upcoming?: boolean;
  limit?: string;
  json?: boolean;
}

export interface EventsImportOptions {
  dryRun?: boolean;
  review?: boolean;
  edges?: boolean;
  json?: boolean;
}

export interface EventsMatchOptions {
  apply?: boolean;
  review?: boolean;
  json?: boolean;
}

function parseLimit(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--limit must be a positive number, got "${value}"`);
  }
  return Math.min(Math.floor(n), max);
}

function when(
  startsAt: string | null,
  endsAt: string | null,
  now = new Date(),
): string {
  if (!startsAt) return "no date";
  const day = utcDay(startsAt);
  const rel = relativeDay(startsAt, now);
  return endsAt && utcDay(endsAt) !== day
    ? `${day} → ${utcDay(endsAt)} (${rel})`
    : `${day} (${rel})`;
}

// ── renderers ────────────────────────────────────────────────────────────

export function renderEventLine(e: EventSummary, now = new Date()): string {
  const where = e.location ? ` · ${e.location}` : "";
  const people =
    e.attendeeCount === 1
      ? "1 in your network"
      : `${e.attendeeCount} in your network`;
  return `  ${e.name}${where} · ${when(e.startsAt, e.endsAt, now)} · ${people}  [${e.id.slice(0, 8)}]`;
}

export function renderEventDetail(
  detail: EventDetail,
  now = new Date(),
): string {
  const { event, attendees, industries, companies, unmatched } = detail;
  const lines = [
    `${event.name}`,
    `  ${when(event.startsAt, event.endsAt, now)}${event.location ? ` · ${event.location}` : ""} · ${event.source}  [${event.id.slice(0, 8)}]`,
  ];

  if (attendees.length === 0) {
    lines.push("  Nobody in your network is linked to this event yet.");
  } else {
    lines.push(`  In your network (${attendees.length}):`);
    for (const a of attendees) {
      const bits = [a.fullName];
      if (a.company) bits.push(a.company);
      const meta = [
        a.eventRole ? `role: ${a.eventRole}` : null,
        a.attended ? null : "planned",
        a.relationshipScore !== null
          ? `score ${a.relationshipScore.toFixed(2)}`
          : null,
      ].filter(Boolean);
      lines.push(
        `    ${bits.join(" — ")}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`,
      );
    }
    if (industries.length > 0)
      lines.push(`  Industries: ${industries.join(", ")}`);
    if (companies.length > 0)
      lines.push(`  Companies: ${companies.join(", ")}`);
  }

  if (unmatched.length > 0) {
    lines.push(
      `  Unmatched attendees (${unmatched.length}) — link them by hand:`,
    );
    for (const u of unmatched) {
      lines.push(`    ${u.email ?? u.name ?? "(blank)"} — ${u.reason}`);
    }
    lines.push(`    netpro events link ${event.id.slice(0, 8)} "<contact>"`);
  }
  return lines.join("\n");
}

export function renderImportSummary(s: ImportEventsSummary): string {
  const head = s.dryRun
    ? `Preview — nothing written. ${s.events} event(s), ${s.matched} attendee(s) would link.`
    : `✓ Imported ${s.events} event(s) (${s.created} new, ${s.existing} already known) · ${s.attendees} attendee row(s) written (${s.duplicates} already linked).`;
  const lines = [head];
  if (s.matched > 0) lines.push(`  matched: ${s.matched}`);
  if (s.review > 0)
    lines.push(
      `  needs review: ${s.review} (re-run with --review to link them)`,
    );
  if (s.ambiguous > 0)
    lines.push(`  ambiguous: ${s.ambiguous} — not linked, pick one by hand`);
  if (s.unmatched > 0)
    lines.push(
      `  unmatched: ${s.unmatched} — parked on the event for manual linking`,
    );
  if (s.edges > 0) {
    lines.push(
      `  ${s.edges} met_at_event edge(s) written as pending — confirm them on /edges.`,
    );
  }
  if (s.edgeCapReached) {
    lines.push(
      "  ⚠ hit the per-event edge cap; remaining co-attendee links were skipped.",
    );
  }
  for (const a of s.ambiguousRefs.slice(0, 5)) {
    lines.push(
      `  ! ${a.ref.email ?? a.ref.name} (${a.event}) matches ${a.candidates
        .map((c) => `${c.fullName} [${c.id.slice(0, 8)}]`)
        .join(", ")}`,
    );
  }
  for (const e of s.errors.slice(0, 5))
    lines.push(`  row ${e.row}: ${e.reason}`);
  for (const w of s.warnings.slice(0, 5))
    lines.push(`  row ${w.row}: ${w.reason}`);
  return lines.join("\n");
}

export function renderMatchResult(r: MatchEventResult): string {
  const lines = [
    r.applied
      ? `${r.event.name}: linked ${r.linked} attendee(s)${r.duplicates > 0 ? `, ${r.duplicates} already linked` : ""}.`
      : `${r.event.name}: ${r.matched} attendee(s) would link (dry run — add --apply).`,
  ];
  if (r.review > 0)
    lines.push(
      `  needs review: ${r.review}${r.applied ? "" : " (add --review to include)"}`,
    );
  if (r.ambiguous > 0) lines.push(`  ambiguous: ${r.ambiguous} — not linked`);
  if (r.unmatched > 0) lines.push(`  unmatched: ${r.unmatched}`);
  if (r.edges > 0)
    lines.push(`  ${r.edges} pending met_at_event edge(s) written.`);
  if (r.edgeCapReached)
    lines.push("  ⚠ hit the per-event edge cap; some links were skipped.");
  for (const m of r.matches.slice(0, 10)) {
    const who = m.ref.email ?? m.ref.name ?? "(blank)";
    lines.push(
      `    ${m.status.padEnd(9)} ${who}${m.reason ? ` — ${m.reason}` : ""}`,
    );
  }
  return lines.join("\n");
}

export function renderRecommendations(
  rows: EventRecommendation[],
  now = new Date(),
): string {
  if (rows.length === 0) {
    return "No events to recommend yet — import one with `netpro events import file.csv`.";
  }
  const lines = [`Recommended events (${rows.length}):`];
  for (const r of rows) {
    lines.push(
      `  ${r.score.toFixed(2)}  ${r.event.name} — ${when(r.event.startsAt, r.event.endsAt, now)}  [${r.event.id.slice(0, 8)}]`,
    );
    lines.push(`         ${r.reasons.join(" · ")}`);
    const names = r.attendees.map((a) => a.fullName);
    if (names.length > 0) lines.push(`         going: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

// ── executors ────────────────────────────────────────────────────────────

export async function executeEventsList(
  opts: EventsListOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const { events, total, limit } = await listEvents(conn, {
    query: opts.query?.trim() || undefined,
    upcoming: opts.upcoming === true,
    limit: parseLimit(opts.limit, 50, 200),
    now,
    scope,
  });
  if (opts.json) return JSON.stringify({ events, total, limit }, null, 2);
  if (events.length === 0) {
    return 'No events yet — add one with: netpro events add "React Conf" --starts 2026-09-14';
  }
  const lines = [
    `Events (${events.length} of ${total}):`,
    ...events.map((e) => renderEventLine(e, now)),
  ];
  const status = await eventsStatus(conn, scope);
  lines.push(
    `  ${status.links} attendance row(s) across ${status.withAttendees} event(s).`,
  );
  return lines.join("\n");
}

export async function executeEventsShow(
  selector: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const event = await resolveEventRef(conn, selector, scope);
  const detail = await getEvent(conn, event.id, scope);
  if (!detail)
    throw new EventError("not_found", `No event with id "${event.id}".`);
  if (opts.json) return JSON.stringify(detail, null, 2);
  return renderEventDetail(detail, now);
}

export async function executeEventsAdd(
  name: string,
  opts: { location?: string; starts?: string; ends?: string; json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const { event, created } = await upsertEvent(
    conn,
    {
      name,
      location: opts.location ?? null,
      startsAt: opts.starts ?? null,
      endsAt: opts.ends ?? null,
      source: "manual",
    },
    { now, scope },
  );
  if (opts.json) return JSON.stringify({ event, created }, null, 2);
  return created
    ? `✓ Added ${event.name} (${when(event.startsAt, event.endsAt, now)})  [${event.id.slice(0, 8)}]`
    : `= ${event.name} already exists  [${event.id.slice(0, 8)}]`;
}

export async function executeEventsImport(
  path: string,
  opts: EventsImportOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const csv = readFileSync(path, "utf-8");
  const summary = await importEvents(conn, {
    csv,
    now,
    dryRun: opts.dryRun,
    includeReview: opts.review,
    edges: opts.edges !== false,
    scope,
  });
  if (opts.json) return JSON.stringify(summary, null, 2);
  return renderImportSummary(summary);
}

export async function executeEventsMatch(
  selector: string,
  opts: EventsMatchOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const result = await matchEventAttendees(conn, selector, {
    now,
    apply: opts.apply === true,
    includeReview: opts.review === true,
    scope,
  });
  if (opts.json) return JSON.stringify(result, null, 2);
  return renderMatchResult(result);
}

export async function executeEventsLink(
  selector: string,
  contactSelector: string,
  opts: { role?: string; json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const event = await resolveEventRef(conn, selector, scope);
  const contact = await resolveContactRef(conn, contactSelector, scope);
  const result = await linkAttendee(
    conn,
    {
      eventId: event.id,
      contactId: contact.id,
      role: opts.role ?? null,
      via: "manual",
    },
    { now, scope },
  );
  if (opts.json) return JSON.stringify({ event, contact, ...result }, null, 2);
  const verb = result.created ? "Linked" : "Already linked";
  const edges =
    result.edgesCreated > 0
      ? ` · ${result.edgesCreated} confirmed met_at_event edge(s)`
      : "";
  return `✓ ${verb} ${contact.fullName} → ${event.name}${edges}.`;
}

export async function executeEventsUnlink(
  selector: string,
  contactSelector: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const event = await resolveEventRef(conn, selector, scope);
  const contact = await resolveContactRef(conn, contactSelector, scope);
  const result = await unlinkAttendee(
    conn,
    { eventId: event.id, contactId: contact.id },
    { scope },
  );
  if (opts.json) return JSON.stringify({ event, contact, ...result }, null, 2);
  return result.removed
    ? `✗ Removed ${contact.fullName} from ${event.name}.`
    : `= ${contact.fullName} was not linked to ${event.name}.`;
}

export async function executeEventsRecommend(
  opts: { limit?: string; json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const rows = await recommendEvents(conn, {
    limit: parseLimit(opts.limit, 10, 50),
    now,
    scope,
  });
  if (opts.json) return JSON.stringify(rows, null, 2);
  return renderRecommendations(rows, now);
}

export async function executeEventsRm(
  selector: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const event = await resolveEventRef(conn, selector, scope);
  const removed = await removeEvent(conn, event.id, { scope });
  if (opts.json)
    return JSON.stringify(
      { removed, remaining: await countEvents(conn) },
      null,
      2,
    );
  return `✗ Removed ${removed.name} (attendance rows went with it; any edges it produced stay until you remove them).`;
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
    console.error(`netpro events: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerEventsCommand(program: Command): void {
  const events = program
    .command("events")
    .description(
      "Event matcher — who in your network went, and what to attend next (v2.0)",
    );

  events
    .command("list")
    .description("List events with how many of your contacts attended")
    .option("--query <text>", "Filter by name")
    .option("--upcoming", "Only events that have not started yet")
    .option("--limit <n>", "Max rows (default 50)", "50")
    .option("--json", "Print the result as JSON")
    .action((opts: EventsListOptions) =>
      run(events, (conn, scope) =>
        executeEventsList(opts, conn, new Date(), scope),
      ),
    );

  events
    .command("show <event>")
    .description(
      "Show one event and its overlap with your network (id or exact name)",
    )
    .option("--json", "Print the result as JSON")
    .action((event: string, opts: { json?: boolean }) =>
      run(events, (conn, scope) =>
        executeEventsShow(event, opts, conn, new Date(), scope),
      ),
    );

  events
    .command("add <name>")
    .description("Add an event by hand")
    .option("--location <text>", "City or venue")
    .option("--starts <date>", "YYYY-MM-DD (or an ISO timestamp)")
    .option("--ends <date>", "YYYY-MM-DD")
    .option("--json", "Print the result as JSON")
    .action(
      (
        name: string,
        opts: {
          location?: string;
          starts?: string;
          ends?: string;
          json?: boolean;
        },
      ) =>
        run(events, (conn, scope) =>
          executeEventsAdd(name, opts, conn, new Date(), scope),
        ),
    );

  events
    .command("import <csv>")
    .description("Import events + attendee lists from CSV and match attendees")
    .option("--dry-run", "Preview what would be written")
    .option("--review", "Also link last-name + initial matches")
    .option(
      "--no-edges",
      "Do not create met_at_event edges between co-attendees",
    )
    .option("--json", "Print the summary as JSON")
    .action((csv: string, opts: EventsImportOptions) =>
      run(events, (conn, scope) =>
        executeEventsImport(csv, opts, conn, new Date(), scope),
      ),
    );

  events
    .command("match <event>")
    .description(
      "Re-match an event’s unresolved attendees against the current network",
    )
    .option("--apply", "Write the links (default is a preview)")
    .option("--review", "Also link last-name + initial matches")
    .option("--json", "Print the result as JSON")
    .action((event: string, opts: EventsMatchOptions) =>
      run(events, (conn, scope) =>
        executeEventsMatch(event, opts, conn, new Date(), scope),
      ),
    );

  events
    .command("link <event> <contact>")
    .description("Record that a contact attended an event (confirmed)")
    .option("--role <role>", "Their role there, e.g. speaker")
    .option("--json", "Print the result as JSON")
    .action(
      (
        event: string,
        contact: string,
        opts: { role?: string; json?: boolean },
      ) =>
        run(events, (conn, scope) =>
          executeEventsLink(event, contact, opts, conn, new Date(), scope),
        ),
    );

  events
    .command("unlink <event> <contact>")
    .description("Remove an attendance row")
    .option("--json", "Print the result as JSON")
    .action((event: string, contact: string, opts: { json?: boolean }) =>
      run(events, (conn, scope) =>
        executeEventsUnlink(event, contact, opts, conn, scope),
      ),
    );

  events
    .command("recommend")
    .description(
      "Rank events by how many of your contacts went, industry fit and timing",
    )
    .option("--limit <n>", "Max rows (default 10)", "10")
    .option("--json", "Print the result as JSON")
    .action((opts: { limit?: string; json?: boolean }) =>
      run(events, (conn, scope) =>
        executeEventsRecommend(opts, conn, new Date(), scope),
      ),
    );

  events
    .command("rm <event>")
    .description("Delete an event and its attendance rows")
    .option("--json", "Print the result as JSON")
    .action((event: string, opts: { json?: boolean }) =>
      run(events, (conn, scope) => executeEventsRm(event, opts, conn, scope)),
    );
}
