// apps/web/app/(app)/events/[id]/page.tsx
//
// One event: the overlap with your network (who was there, what they do, how
// strong each tie is) and the attendee lines the last import could not
// resolve. Those unresolved lines are kept, not discarded — you can re-check
// them after importing new contacts, or link them by hand here.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  getEvent,
  resolveEventRef,
  type EventDetail,
} from "@netpro/core/src/events";
import { dueLabel, scoreLabel } from "@/lib/format";
import {
  AddAttendeeForm,
  LinkUnmatchedForm,
  MatchPanel,
  RemoveAttendeeButton,
  RemoveEventButton,
} from "../panels";

function when(detail: EventDetail, now: Date): string {
  const { startsAt, endsAt } = detail.event;
  if (!startsAt) return "no date";
  return endsAt && endsAt.slice(0, 10) !== startsAt.slice(0, 10)
    ? `${dueLabel(startsAt, now)} → ${endsAt.slice(0, 10)}`
    : dueLabel(startsAt, now);
}

function Attendees({ detail }: { detail: EventDetail }) {
  if (detail.attendees.length === 0) {
    return (
      <p style={{ color: "#9ca3af" }}>
        Nobody in your network is linked to this event yet — add someone below,
        or import an attendee list.
      </p>
    );
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
          <th style={{ padding: "0.4rem 0.5rem" }}>Contact</th>
          <th style={{ padding: "0.4rem 0.5rem" }}>Company</th>
          <th style={{ padding: "0.4rem 0.5rem" }}>At the event</th>
          <th style={{ padding: "0.4rem 0.5rem" }}>Tie</th>
          <th style={{ padding: "0.4rem 0.5rem" }} />
        </tr>
      </thead>
      <tbody>
        {detail.attendees.map((a) => (
          <tr key={a.contactId} style={{ borderBottom: "1px solid #f3f4f6" }}>
            <td style={{ padding: "0.4rem 0.5rem" }}>
              <Link href={`/contacts/${encodeURIComponent(a.contactId)}`}>
                {a.fullName}
              </Link>
            </td>
            <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>
              {a.company ?? "—"}
            </td>
            <td style={{ padding: "0.4rem 0.5rem", color: "#374151" }}>
              {[a.eventRole, a.attended ? "attended" : "planned"]
                .filter(Boolean)
                .join(" · ")}
            </td>
            <td style={{ padding: "0.4rem 0.5rem" }}>
              {scoreLabel(a.relationshipScore)}
            </td>
            <td style={{ padding: "0.4rem 0.5rem" }}>
              <RemoveAttendeeButton
                eventId={detail.event.id}
                contactId={a.contactId}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unmatched({ detail }: { detail: EventDetail }) {
  if (detail.unmatched.length === 0) return null;
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1rem" }}>
        Unmatched attendees ({detail.unmatched.length})
      </h2>
      <p style={{ color: "#6b7280", margin: "0 0 0.5rem" }}>
        These lines from the imported list matched no contact — or matched more
        than one. Nothing was linked; name the right person to link them.
      </p>
      <ul style={{ paddingLeft: "1.25rem" }}>
        {detail.unmatched.map((u, i) => {
          const label = u.email ?? u.name ?? "(blank)";
          return (
            <li key={`${label}-${i}`} style={{ marginBottom: "0.4rem" }}>
              <strong>{label}</strong> — {u.reason}
              <div style={{ marginTop: "0.25rem" }}>
                <LinkUnmatchedForm eventId={detail.event.id} label={label} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await requireScope();
  const event = await resolveEventRef(conn, id, scope).catch(() => null);
  if (!event) notFound();
  const detail = await getEvent(conn, event.id, scope);
  if (!detail) notFound();

  const now = new Date();
  return (
    <div>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/events">← Events</Link>
      </p>
      <h1>{detail.event.name}</h1>
      <p style={{ margin: "0.25rem 0", color: "#475569" }}>
        {[when(detail, now), detail.event.location].filter(Boolean).join(" · ")}{" "}
        · source {detail.event.source}
      </p>

      {detail.industries.length > 0 ? (
        <p style={{ margin: "0.25rem 0", color: "#6b7280" }}>
          Industries: {detail.industries.join(", ")}
          {detail.companies.length > 0
            ? ` · Companies: ${detail.companies.join(", ")}`
            : ""}
        </p>
      ) : null}

      <p style={{ margin: "0.5rem 0" }}>
        <strong>{detail.attendeeCount}</strong> in your network.{" "}
        {detail.attendees[0] ? (
          <Link
            href={`/graph?target=${encodeURIComponent(detail.attendees[0]!.contactId)}`}
          >
            Find a warm intro to {detail.attendees[0]!.fullName}
          </Link>
        ) : (
          <>
            Once someone is linked, <Link href="/graph">Graph</Link> can plan
            the introduction.
          </>
        )}
      </p>

      <section style={{ marginTop: "1rem" }}>
        <h2 style={{ fontSize: "1rem" }}>In your network</h2>
        <Attendees detail={detail} />
      </section>

      <Unmatched detail={detail} />
      <MatchPanel eventId={detail.event.id} />
      <AddAttendeeForm eventId={detail.event.id} />

      <section aria-label="Danger zone" style={{ marginTop: "1.5rem" }}>
        <RemoveEventButton eventId={detail.event.id} />
      </section>
    </div>
  );
}
