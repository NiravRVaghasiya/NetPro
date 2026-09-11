// apps/web/app/(app)/people/page.tsx
//
// Phase 9 — People: the server-backed contacts list.
//
// The plan's "People" is the Web UI's CRM surface. It must not duplicate
// `packages/core`'s contact logic — it calls the server's Web API, which
// orchestrates `packages/core/src/crm`. This page demonstrates that contract:
//
//   GET /api/contacts?limit=&offset=&sort=   → { contacts, total, limit, offset }
//   GET /api/contacts/:id                    → ContactTimeline (via /contacts/[id])
//
// The server is the source of truth for workspace scoping; the browser never
// invents an id. When the server is not reachable the page falls back to the
// direct-DB CRM (the same codepath the legacy /contacts page uses) so the
// operator is not blocked during `next dev`.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { conn } from "@/lib/db";
import { listCrmContacts } from "@netpro/core/src/crm";

export const metadata = { title: "People — NetPro" };

type SearchParams = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireScope();
  const sp = await searchParams;
  const limit = Math.min(Math.max(Number(one(sp.limit) ?? 25), 1), 100);
  const offset = Math.max(Number(one(sp.offset) ?? 0), 0);
  const sort = one(sp.sort) ?? "recent";
  const q = one(sp.q) ?? one(sp.query) ?? "";
  const serverUrl = getServerUrl();

  // Prefer server; fall back to direct core.
  let contacts: Array<{
    id: string;
    fullName: string;
    company?: string | null;
    role?: string | null;
    email?: string | null;
    relationshipScore?: number | null;
    lastInteraction?: string | null;
  }> = [];
  let total = 0;
  let serverReachable = false;
  let serverError: string | null = null;

  try {
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      sort,
    });
    if (q) qs.set("q", q);
    // The server's /api/contacts does not support free-text `q` yet — it is a
    // CRM list. When `q` is present we hit /api/search instead, which is the
    // hybrid path. For now keep people as the CRM list and use search for `q`.
    const path = q ? `/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}` : `/api/contacts?${qs.toString()}`;
    const res = await serverFetchJson<{
      contacts?: typeof contacts;
      total?: number;
      // search shape is also supported
    }>(path);
    if (res.ok) {
      const data = res.data as { contacts?: typeof contacts; total?: number };
      // /api/search returns { contacts, total } as well, so unify.
      if (Array.isArray((data as { contacts: unknown }).contacts)) {
        contacts = (data as { contacts: typeof contacts }).contacts;
        total = data.total ?? contacts.length;
      } else if (Array.isArray((data as unknown as { results?: unknown[] }).results)) {
        // Defensive: some search impls return results
        contacts = [];
        total = 0;
      }
      serverReachable = true;
    } else {
      serverError = (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }

  if (!serverReachable) {
    try {
      // Direct-DB fallback — never duplicates business logic, just calls core.
      const page = await listCrmContacts(conn, { limit, offset, sort: (sort as "recent" | "score" | "name" | "follow-up") ?? "recent" });
      contacts = page.contacts as typeof contacts;
      total = page.total;
    } catch (e) {
      serverError = e instanceof Error ? e.message : String(e);
      contacts = [];
      total = 0;
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>People</h1>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          {total} contact{total === 1 ? "" : "s"}
          {q ? (
            <>
              {" "}
              matching &quot;{q}&quot;
            </>
          ) : null}
          {!serverReachable ? <span style={{ color: "#92400e" }}> — local</span> : null}
        </span>
        <span style={{ color: "#9ca3af", fontSize: "0.8rem", marginLeft: "auto" }}>
          via {serverReachable ? serverUrl : "local DB"}
        </span>
      </div>

      {!serverReachable ? (
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            borderRadius: 10,
            padding: "0.5rem 0.9rem",
            marginTop: "0.6rem",
            fontSize: "0.85rem",
          }}
        >
          Server not reachable at <code>{serverUrl}</code> — showing local data. Run <code>netpro serve</code> for the server-backed
          view with live updates. {serverError ? <em> ({serverError})</em> : null}
        </div>
      ) : null}

      <form method="GET" action="/people" style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem", flexWrap: "wrap" }}>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search people… (name, company, role)"
          style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.4rem 0.7rem", flex: "1 1 260px" }}
        />
        <select name="sort" defaultValue={sort} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.4rem 0.6rem" }}>
          <option value="recent">Recent</option>
          <option value="score">Score</option>
          <option value="name">Name</option>
          <option value="follow-up">Follow-up</option>
        </select>
        <button type="submit" style={{ background: "#111827", color: "white", borderRadius: 8, padding: "0.4rem 0.9rem", border: "none" }}>
          Search
        </button>
        <Link
          href="/people"
          style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.4rem 0.9rem", textDecoration: "none", color: "#374151" }}
        >
          Clear
        </Link>
      </form>

      {contacts.length === 0 ? (
        <p style={{ color: "#9ca3af", marginTop: "1rem" }}>
          No contacts yet.{" "}
          <Link href="/import" style={{ color: "#2563eb" }}>
            Import a LinkedIn CSV
          </Link>{" "}
          or run <code>netpro import contacts.csv</code> — then watch them appear in{" "}
          <Link href="/activity" style={{ color: "#2563eb" }}>
            Activity
          </Link>
          .
        </p>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "0.5rem 0.6rem" }}>Name</th>
                <th style={{ padding: "0.5rem 0.6rem" }}>Company</th>
                <th style={{ padding: "0.5rem 0.6rem" }}>Role</th>
                <th style={{ padding: "0.5rem 0.6rem" }}>Score</th>
                <th style={{ padding: "0.5rem 0.6rem" }}>Last touch</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    <Link href={`/contacts/${c.id}`} style={{ color: "#2563eb" }}>
                      {c.fullName}
                    </Link>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{c.company ?? "—"}</td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{c.role ?? "—"}</td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{c.relationshipScore !== null && c.relationshipScore !== undefined ? c.relationshipScore.toFixed(2) : "—"}</td>
                  <td style={{ padding: "0.5rem 0.6rem", color: "#6b7280" }}>{c.lastInteraction ? c.lastInteraction.slice(0, 10) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
            {offset > 0 ? (
              <Link
                href={`/people?${new URLSearchParams({ limit: String(limit), offset: String(Math.max(0, offset - limit)), sort, ...(q ? { q } : {}) }).toString()}`}
                style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
              >
                ← Prev
              </Link>
            ) : null}
            {offset + limit < total ? (
              <Link
                href={`/people?${new URLSearchParams({ limit: String(limit), offset: String(offset + limit), sort, ...(q ? { q } : {}) }).toString()}`}
                style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
              >
                Next →
              </Link>
            ) : null}
            <span style={{ color: "#9ca3af", fontSize: "0.85rem", alignSelf: "center" }}>
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
          </div>
        </>
      )}

      <p style={{ marginTop: "1rem", color: "#6b7280", fontSize: "0.85rem" }}>
        This page calls <code>GET /api/contacts</code> and <code>GET /api/search</code> on the local NetPro server, which in turn
        calls <code>@netpro/core</code> — the UI never reimplements CRM scoring. Legacy route{" "}
        <Link href="/contacts" style={{ color: "#2563eb" }}>
          /contacts
        </Link>{" "}
        remains until Phase 24.
      </p>
    </div>
  );
}
