import Link from "next/link";
import { conn } from "@/lib/db";
import {
  searchContacts,
  type SearchContactsOptions,
  type SearchFacets,
  type FacetBucket,
} from "@netpro/core/src/search";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SENIORITIES = [
  "intern",
  "junior",
  "mid",
  "senior",
  "lead",
  "director",
  "vp",
  "c_level",
];
const SORTS: Array<{ value: string; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "score", label: "Relationship score" },
  { value: "recent", label: "Recently active" },
  { value: "name", label: "Name (A–Z)" },
];

function buildParams(
  sp: SearchParams,
  override: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  const keys = [
    "q",
    "company",
    "role",
    "location",
    "industry",
    "seniority",
    "sort",
    "limit",
  ];
  const current: Record<string, string | undefined> = {};
  for (const k of keys) current[k] = one(sp[k]);
  if (one(sp["hasEmail"]) === "true") current.hasEmail = "true";
  Object.assign(current, override);
  for (const [k, v] of Object.entries(current)) {
    if (v !== undefined && v !== "") params.set(k, v);
  }
  return params.toString();
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const limit = Number(one(sp.limit) ?? "25");
  const offset = Number(one(sp.offset) ?? "0");

  const options: SearchContactsOptions = {
    query: one(sp.q),
    company: one(sp.company),
    role: one(sp.role),
    location: one(sp.location),
    industry: one(sp.industry),
    seniority: one(sp.seniority),
    hasEmail: one(sp.hasEmail) === "true",
    sort: (one(sp.sort) as SearchContactsOptions["sort"]) ?? "relevance",
    limit: Number.isNaN(limit) ? 25 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
  };

  const results = await searchContacts(conn, options);
  const activeSort = options.sort ?? "relevance";

  return (
    <div>
      <h1>Search</h1>

      <form method="GET" action="/search">
        <input
          type="search"
          name="q"
          placeholder="Search by name, company, role, email…"
          defaultValue={options.query ?? ""}
          aria-label="Search contacts"
        />
        <button type="submit">Search</button>
      </form>

      <form
        method="GET"
        action="/search"
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginTop: "0.75rem",
        }}
      >
        {/* Preserve the free-text query across filter changes. */}
        <input type="hidden" name="q" value={options.query ?? ""} />
        <input
          name="company"
          placeholder="Company"
          defaultValue={options.company ?? ""}
        />
        <input
          name="role"
          placeholder="Role"
          defaultValue={options.role ?? ""}
        />
        <input
          name="location"
          placeholder="Location"
          defaultValue={options.location ?? ""}
        />
        <input
          name="industry"
          placeholder="Industry"
          defaultValue={options.industry ?? ""}
        />
        <select name="seniority" defaultValue={options.seniority ?? ""}>
          <option value="">Any seniority</option>
          {SENIORITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
        >
          <input
            type="checkbox"
            name="hasEmail"
            value="true"
            defaultChecked={options.hasEmail}
          />
          Has email
        </label>
        <button type="submit">Filter</button>
        <Link href="/search">Clear</Link>
      </form>

      <p style={{ marginTop: "1rem" }}>
        <strong>{results.total}</strong> contact{results.total === 1 ? "" : "s"}{" "}
        found
      </p>

      <div style={{ display: "flex", gap: "1.5rem", marginTop: "1rem" }}>
        {results.total > 0 && <Facets facets={results.facets} sp={sp} />}

        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: "0.5rem" }}>
            Sort by:{" "}
            {SORTS.map((s) => (
              <span key={s.value} style={{ marginRight: "0.75rem" }}>
                {activeSort === s.value ? (
                  <strong>{s.label}</strong>
                ) : (
                  <Link
                    href={`/search?${buildParams(sp, { sort: s.value, offset: undefined })}`}
                  >
                    {s.label}
                  </Link>
                )}
              </span>
            ))}
          </div>

          {results.contacts.length === 0 ? (
            <p>No contacts match your search.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Role</th>
                  <th>Location</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {results.contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/contacts/${c.id}`}>{c.fullName}</Link>
                    </td>
                    <td>{c.company ?? ""}</td>
                    <td>{c.role ?? ""}</td>
                    <td>{c.location ?? ""}</td>
                    <td>
                      {c.relationshipScore !== null
                        ? c.relationshipScore.toFixed(2)
                        : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: "1rem", display: "flex", gap: "1rem" }}>
            {results.offset > 0 && (
              <Link
                href={`/search?${buildParams(sp, { offset: String(Math.max(0, results.offset - results.limit)) })}`}
              >
                ← Previous
              </Link>
            )}
            {results.offset + results.contacts.length < results.total && (
              <Link
                href={`/search?${buildParams(sp, { offset: String(results.offset + results.limit) })}`}
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Facets({ facets, sp }: { facets: SearchFacets; sp: SearchParams }) {
  const facetDefs: Array<{
    key: keyof SearchFacets;
    param: string;
    label: string;
  }> = [
    { key: "company", param: "company", label: "Company" },
    { key: "role", param: "role", label: "Role" },
    { key: "location", param: "location", label: "Location" },
    { key: "industry", param: "industry", label: "Industry" },
    { key: "seniority", param: "seniority", label: "Seniority" },
  ];

  return (
    <aside style={{ minWidth: 160 }}>
      {facetDefs.map(({ key, param, label }) => {
        const buckets: FacetBucket[] = facets[key] ?? [];
        if (buckets.length === 0) return null;
        return (
          <div key={key} style={{ marginBottom: "1rem" }}>
            <h3 style={{ margin: "0 0 0.25rem" }}>{label}</h3>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {buckets.map((b) => (
                <li key={b.value}>
                  <Link
                    href={`/search?${buildParams(sp, { [param]: b.value, offset: undefined })}`}
                  >
                    {b.value} ({b.count})
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}
