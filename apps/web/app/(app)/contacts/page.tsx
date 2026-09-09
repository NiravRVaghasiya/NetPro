import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  CRM_CONTACTS_SORTS,
  listCrmContacts,
  listFollowUps,
  type CrmContactsSort,
} from "@netpro/core/src/crm";
import { dueLabel, relativeDayLabel, scoreLabel } from "@/lib/format";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SORT_LABELS: Record<CrmContactsSort, string> = {
  recent: "Recently active",
  score: "Relationship score",
  name: "Name (A–Z)",
  "follow-up": "Next follow-up",
};

const PAGE_SIZE = 25;

/**
 * /contacts — the CRM view from the blueprint: all contacts with last
 * interaction, relationship score, and follow-up dates, plus the pending
 * follow-ups that need attention. Reads go straight through the core module
 * (same pattern as /search and /dashboard); mutations live on the contact
 * detail page.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const sortParam = one(sp.sort);
  const sort = CRM_CONTACTS_SORTS.includes(sortParam as CrmContactsSort)
    ? (sortParam as CrmContactsSort)
    : "recent";
  const rawOffset = Number(one(sp.offset) ?? "0");
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.floor(rawOffset))
    : 0;
  const assignedToMe = one(sp.assignedToMe) === "1";
  const unassigned = one(sp.unassigned) === "1";

  const scope = await requireScope();
  const [page, followUps] = await Promise.all([
    listCrmContacts(conn, { limit: PAGE_SIZE, offset, sort }, scope),
    listFollowUps(
      conn,
      {
        view: "pending",
        limit: 5,
        assignedToMe: assignedToMe ? scope.userId : undefined,
        unassigned: unassigned ? true : undefined,
      },
      scope
    ),
  ]);
  const now = new Date();

  const sortHref = (value: CrmContactsSort) =>
    `/contacts?sort=${value}${offset > 0 ? `&offset=${offset}` : ""}`;

  return (
    <div>
      <h1>Contacts</h1>
      <p style={{ marginTop: "0.25rem" }}>
        <strong>{page.total}</strong> contact{page.total === 1 ? "" : "s"} ·{" "}
        <span
          style={{
            color: followUps.counts.overdue > 0 ? "#b91c1c" : undefined,
          }}
        >
          {followUps.counts.overdue} overdue
        </span>{" "}
        · {followUps.counts.dueToday} due today · {followUps.counts.upcoming}{" "}
        upcoming{" "}
        <Link href="/api/export?format=csv" style={{ marginLeft: "0.75rem" }}>
          Export CSV
        </Link>{" "}
        <span style={{ marginLeft: "0.75rem" }}>
          Filters:{" "}
          <Link href="/contacts">all</Link> ·{" "}
          <Link href="/contacts?assignedToMe=1">assigned to me</Link> ·{" "}
          <Link href="/contacts?unassigned=1">unassigned</Link>
          {assignedToMe && <strong> (assigned to me)</strong>}
          {unassigned && <strong> (unassigned)</strong>}
        </span>
      </p>

      {page.total === 0 ? (
        <p>
          No contacts yet. <Link href="/import">Import your connections</Link>{" "}
          to get started.
        </p>
      ) : (
        <>
          {followUps.followUps.length > 0 && (
            <section aria-label="Due follow-ups" style={{ marginTop: "1rem" }}>
              <h2 style={{ fontSize: "1rem" }}>Needs attention</h2>
              <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
                {followUps.followUps.map((f) => (
                  <li key={f.id}>
                    <Link href={`/contacts/${f.contactId}`}>
                      {f.contactName}
                    </Link>{" "}
                    — due {relativeDayLabel(f.effectiveDueAt, now)}
                    {f.reason ? ` · “${f.reason}”` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div style={{ marginBottom: "0.5rem", marginTop: "1rem" }}>
            Sort by:{" "}
            {CRM_CONTACTS_SORTS.map((s) => (
              <span key={s} style={{ marginRight: "0.75rem" }}>
                {sort === s ? (
                  <strong>{SORT_LABELS[s]}</strong>
                ) : (
                  <Link href={sortHref(s)}>{SORT_LABELS[s]}</Link>
                )}
              </span>
            ))}
          </div>

          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Role</th>
                <th>Last touch</th>
                <th>Interactions</th>
                <th>Score</th>
                <th>Next follow-up</th>
              </tr>
            </thead>
            <tbody>
              {page.contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/contacts/${c.id}`}>{c.fullName}</Link>
                  </td>
                  <td>{c.company ?? ""}</td>
                  <td>{c.role ?? ""}</td>
                  <td>
                    {c.lastInteraction
                      ? relativeDayLabel(c.lastInteraction, now)
                      : "–"}
                  </td>
                  <td>{c.interactionCount}</td>
                  <td>{scoreLabel(c.relationshipScore)}</td>
                  <td>{dueLabel(c.nextFollowUpAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: "1rem", display: "flex", gap: "1rem" }}>
            {offset > 0 && (
              <Link
                href={`/contacts?sort=${sort}&offset=${Math.max(0, offset - PAGE_SIZE)}`}
              >
                ← Previous
              </Link>
            )}
            {offset + page.contacts.length < page.total && (
              <Link
                href={`/contacts?sort=${sort}&offset=${offset + PAGE_SIZE}`}
              >
                Next →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
