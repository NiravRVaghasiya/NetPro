// apps/web/app/(app)/people/[id]/page.tsx
//
// Phase 24 — a read-only contact detail page, server-backed.
//
// The legacy `/contacts/[id]` page (direct database access, follow-up /
// interaction editing panels, and their duplicated API routes) was removed in
// Phase 24. This page is its thin, read-only successor: it renders
// `GET /api/contacts/:id` — the ContactTimeline aggregate that
// `packages/server` builds from `@netpro/core/src/crm/timeline.ts` — and adds
// no business logic of its own.
//
//   profile + denormalized stats + recent interactions + pending follow-ups

import Link from "next/link";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";

export const metadata = { title: "Contact — NetPro" };

type Params = Promise<{ id: string }>;

type ContactRow = {
  id: string;
  fullName: string;
  company?: string | null;
  role?: string | null;
  email?: string | null;
  location?: string | null;
  relationshipScore?: number | null;
  lastInteraction?: string | null;
  linkedinUrl?: string | null;
  industry?: string | null;
  skills?: string[];
  tags?: string[];
  [key: string]: unknown;
};

type Timeline = {
  contact: ContactRow | null;
  stats?: {
    lastInteraction?: string | null;
    interactionCount?: number;
    relationshipScore?: number;
  } | null;
  interactions?: Array<{
    id: string;
    kind?: string | null;
    note?: string | null;
    occurredAt?: string | null;
    createdAt?: string | null;
    [key: string]: unknown;
  }>;
  followUps?: Array<{
    id: string;
    summary?: string | null;
    dueAt?: string | null;
    dueDate?: string | null;
    completed?: boolean;
    [key: string]: unknown;
  }>;
};

export default async function ContactDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const serverUrl = getServerUrl();

  let timeline: Timeline | null = null;
  let notFound = false;
  let serverError: string | null = null;

  try {
    const res = await serverFetchJson<Timeline & { error?: string }>(
      `/api/contacts/${encodeURIComponent(id)}`,
    );
    if (res.ok) {
      timeline = res.data;
      if (!timeline?.contact) notFound = true;
    } else if (res.status === 404) {
      notFound = true;
    } else {
      serverError =
        (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }

  if (serverError) {
    return (
      <div>
        <p>
          <Link href="/people" style={{ color: "#2563eb" }}>
            ← People
          </Link>
        </p>
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            borderRadius: 10,
            padding: "0.75rem 1rem",
            marginTop: "1rem",
          }}
        >
          Server not reachable at <code>{serverUrl}</code> — run <code>netpro serve</code> to view contacts.{" "}
          <em>({serverError})</em>
        </div>
      </div>
    );
  }

  if (notFound || !timeline?.contact) {
    return (
      <div>
        <p>
          <Link href="/people" style={{ color: "#2563eb" }}>
            ← People
          </Link>
        </p>
        <p style={{ color: "#9ca3af", marginTop: "1rem" }}>No contact with id &quot;{id}&quot;.</p>
      </div>
    );
  }

  const { contact, stats, interactions, followUps } = timeline;
  const score =
    stats?.relationshipScore ?? contact.relationshipScore ?? 0;

  return (
    <div style={{ maxWidth: 720 }}>
      <p>
        <Link href="/people" style={{ color: "#2563eb" }}>
          ← People
        </Link>
      </p>

      <h1 style={{ margin: "0.5rem 0 0" }}>{contact.fullName}</h1>
      <p style={{ color: "#6b7280", marginTop: "0.2rem" }}>
        {[contact.company, contact.role, contact.location].filter(Boolean).join(" · ") || "No company details"}
      </p>

      <div
        style={{
          display: "flex",
          gap: "1.25rem",
          flexWrap: "wrap",
          marginTop: "1rem",
        }}
      >
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.75rem 1rem", minWidth: 130 }}>
          <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Relationship
          </div>
          <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{score.toFixed(2)}</div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.75rem 1rem", minWidth: 130 }}>
          <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Interactions
          </div>
          <div style={{ fontSize: "1.35rem", fontWeight: 700 }}>{stats?.interactionCount ?? interactions?.length ?? 0}</div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.75rem 1rem", minWidth: 130 }}>
          <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Last touch
          </div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
            {stats?.lastInteraction ? stats.lastInteraction.slice(0, 10) : "—"}
          </div>
        </div>
      </div>

      {contact.email ? (
        <p style={{ marginTop: "1rem" }}>
          <span style={{ color: "#6b7280" }}>Email: </span>
          <code>{contact.email}</code>
        </p>
      ) : null}
      {contact.industry ? (
        <p style={{ marginTop: "0.4rem" }}>
          <span style={{ color: "#6b7280" }}>Industry: </span>
          {contact.industry}
        </p>
      ) : null}
      {contact.skills && contact.skills.length > 0 ? (
        <p style={{ marginTop: "0.4rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
          {contact.skills.map((s) => (
            <span
              key={`skill-${s}`}
              style={{ fontSize: "0.75rem", background: "#eff6ff", color: "#1d4ed8", borderRadius: 999, padding: "0.1rem 0.55rem" }}
            >
              {s}
            </span>
          ))}
        </p>
      ) : null}
      {contact.tags && contact.tags.length > 0 ? (
        <p style={{ marginTop: "0.4rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
          {contact.tags.map((t) => (
            <span
              key={`tag-${t}`}
              style={{ fontSize: "0.75rem", background: "#f5f3ff", color: "#6d28d9", borderRadius: 999, padding: "0.1rem 0.55rem" }}
            >
              #{t}
            </span>
          ))}
        </p>
      ) : null}

      <section style={{ marginTop: "1.75rem" }}>
        <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.6rem" }}>Recent interactions</h2>
        {!interactions || interactions.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>No interactions recorded yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {interactions.map((i) => (
              <li key={i.id} style={{ borderTop: "1px solid #f3f4f6", padding: "0.5rem 0" }}>
                <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>
                  {i.occurredAt ? i.occurredAt.slice(0, 10) : i.createdAt ? i.createdAt.slice(0, 10) : "—"} ·{" "}
                  {i.kind ?? "interaction"}
                </span>
                {i.note ? <div style={{ color: "#374151" }}>{i.note}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.6rem" }}>Pending follow-ups</h2>
        {!followUps || followUps.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>No pending follow-ups.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {followUps.map((f) => (
              <li key={f.id} style={{ borderTop: "1px solid #f3f4f6", padding: "0.5rem 0" }}>
                {f.summary ?? "Follow-up"}
                {f.dueAt || f.dueDate ? (
                  <span style={{ color: "#6b7280", fontSize: "0.8rem" }}> · due {(f.dueAt ?? f.dueDate)!.slice(0, 10)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
