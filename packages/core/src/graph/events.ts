// packages/core/src/graph/events.ts
//
// Phase 1 ships the events schema + a "also met at…" producer so Phase 6
// is logic-only. Recording attendance writes an `event_attendees` row and
// a confirmed `met_at_event` edge between the named contact and every
// other attendee already on that event (owner-confirmed: they typed it).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { getContactById } from "../ai/resolve-contact";
import { addEdge } from "./edges";
import {
  resolveScope,
  workspacePredicate,
  type WorkspaceScope,
} from "../workspaces/scope";
import {
  GRAPH_LIMITS,
  GraphError,
  optionalText,
  resolveNow,
  type GraphOptions,
} from "./types";

export interface EventRow {
  id: string;
  /** v3.0 Phase 2 — tenancy stamp; optional so pre-tenancy fixtures still typecheck. */
  workspaceId?: string;
  name: string;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  source: string;
  createdAt: string;
}

async function findEventByName(
  conn: SqliteConn | PgConn,
  name: string,
  scope?: WorkspaceScope,
): Promise<EventRow | null> {
  if (conn.dialect === "sqlite") {
    const rows = await conn.db
      .select()
      .from(conn.schema.events)
      .where(
        and(
          eq(conn.schema.events.name, name),
          workspacePredicate(scope, conn.schema.events.workspaceId),
        ),
      )
      .limit(1);
    return (rows[0] as EventRow | undefined) ?? null;
  }
  const rows = await conn.db
    .select()
    .from(conn.schema.events)
    .where(
      and(
        eq(conn.schema.events.name, name),
        workspacePredicate(scope, conn.schema.events.workspaceId),
      ),
    )
    .limit(1);
  return (rows[0] as EventRow | undefined) ?? null;
}

export async function findOrCreateEvent(
  conn: SqliteConn | PgConn,
  input: {
    name: string;
    location?: string | null;
    startsAt?: string | null;
    source?: string;
  },
  opts: GraphOptions = {},
): Promise<EventRow> {
  const name = optionalText(input.name, GRAPH_LIMITS.eventName, "name");
  if (!name) throw new GraphError("invalid_input", "Event name is required.");
  const existing = await findEventByName(conn, name, opts.scope);
  if (existing) return existing;
  const now = resolveNow(opts);
  const row: EventRow = {
    id: randomUUID(),
    workspaceId: resolveScope(opts.scope).workspaceId,
    name,
    location:
      optionalText(input.location, GRAPH_LIMITS.eventLocation, "location") ??
      null,
    startsAt: input.startsAt ?? null,
    endsAt: null,
    source: input.source ?? "manual",
    createdAt: now.toISOString(),
  };
  if (conn.dialect === "sqlite") {
    await conn.db.insert(conn.schema.events).values(row);
  } else {
    await conn.db.insert(conn.schema.events).values(row);
  }
  return row;
}

export async function listEventAttendeeIds(
  conn: SqliteConn | PgConn,
  eventId: string,
  scope?: WorkspaceScope,
): Promise<string[]> {
  if (conn.dialect === "sqlite") {
    const a = conn.schema.eventAttendees;
    const rows = await conn.db
      .select({ contactId: a.contactId })
      .from(a)
      .where(
        and(eq(a.eventId, eventId), workspacePredicate(scope, a.workspaceId)),
      );
    return rows.map((r) => r.contactId);
  }
  const a = conn.schema.eventAttendees;
  const rows = await conn.db
    .select({ contactId: a.contactId })
    .from(a)
    .where(
      and(eq(a.eventId, eventId), workspacePredicate(scope, a.workspaceId)),
    );
  return rows.map((r) => r.contactId);
}

async function isAttendee(
  conn: SqliteConn | PgConn,
  eventId: string,
  contactId: string,
  scope?: WorkspaceScope,
): Promise<boolean> {
  if (conn.dialect === "sqlite") {
    const a = conn.schema.eventAttendees;
    const existing = await conn.db
      .select({ contactId: a.contactId })
      .from(a)
      .where(
        and(
          eq(a.eventId, eventId),
          eq(a.contactId, contactId),
          workspacePredicate(scope, a.workspaceId),
        ),
      )
      .limit(1);
    return existing.length > 0;
  }
  const a = conn.schema.eventAttendees;
  const existing = await conn.db
    .select({ contactId: a.contactId })
    .from(a)
    .where(
      and(
        eq(a.eventId, eventId),
        eq(a.contactId, contactId),
        workspacePredicate(scope, a.workspaceId),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

/**
 * Record that `contactId` also met people at `eventName`. Creates the event
 * if needed, an attendee row, and confirmed `met_at_event` edges to every
 * other attendee already on the event.
 */
export async function recordEventAttendance(
  conn: SqliteConn | PgConn,
  input: {
    contactId: string;
    eventName: string;
    location?: string | null;
    role?: string | null;
  },
  opts: GraphOptions = {},
): Promise<{ event: EventRow; linked: number }> {
  const contact = await getContactById(conn, input.contactId, opts.scope);
  if (!contact) {
    throw new GraphError(
      "not_found",
      `No contact with id "${input.contactId}".`,
    );
  }
  const event = await findOrCreateEvent(
    conn,
    { name: input.eventName, location: input.location, source: "manual" },
    opts,
  );
  const now = resolveNow(opts).toISOString();
  const already = await isAttendee(conn, event.id, contact.id, opts.scope);

  if (!already) {
    const attendee = {
      workspaceId: resolveScope(opts.scope).workspaceId,
      eventId: event.id,
      contactId: contact.id,
      role: optionalText(input.role, GRAPH_LIMITS.attendeeRole, "role") ?? null,
      attended: true,
      discoveredAt: now,
    };
    if (conn.dialect === "sqlite") {
      await conn.db.insert(conn.schema.eventAttendees).values(attendee);
    } else {
      await conn.db.insert(conn.schema.eventAttendees).values(attendee);
    }
  }

  const others = (
    await listEventAttendeeIds(conn, event.id, opts.scope)
  ).filter((id) => id !== contact.id);
  let linked = 0;
  for (const otherId of others) {
    try {
      await addEdge(
        conn,
        {
          sourceId: contact.id,
          targetId: otherId,
          relation: "met_at_event",
          source: "event_import",
          status: "confirmed",
          confidence: 1,
          context: event.name,
        },
        { ...opts, merge: true },
      );
      linked++;
    } catch {
      // skip soft-deleted peers
    }
  }
  return { event, linked };
}
