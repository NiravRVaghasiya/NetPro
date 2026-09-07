import Link from "next/link";
import { conn } from "@/lib/db";
import {
  isSearchMode,
  searchContacts,
  type SearchContactsOptions,
  type SearchEngineReport,
  type SearchFacets,
  type FacetBucket,
} from "@netpro/core/src/search";
import { searchEmbedder, semanticSearchAvailable } from "@/lib/search-config";

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
    "mode",
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

  // v2.0 Phase 4. An unrecognised ?mode= is ignored rather than 400-ing the
  // page — a stale bookmark should still render results, and the engine badge
  // below reports what actually ran.
  const requestedMode = one(sp.mode);
  const mode = isSearchMode(requestedMode) ? requestedMode : undefined;
  const semanticAvailable = semanticSearchAvailable();

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
    mode,
  };

  const results = await searchContacts(
    conn,
    options,
    mode === "hybrid" ? { embedder: searchEmbedder() } : {},
  );
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
        <select name="mode" defaultValue={mode ?? "portable"} aria-label="Search engine">
          <option value="portable">Exact match</option>
          <option value="keyword">Smart (full-text)</option>
          {/* Only offered when a key is configured: a toggle that silently
              does nothing is worse than no toggle. */}
          {semanticAvailable ? <option value="hybrid">Smart + semantic</option> : null}
        </select>
        <button type="submit">Search</button>
      </form>

      <EngineBadge
        engine={results.engine}
        semanticAvailable={semanticAvailable}
      />

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
        {mode ? <input type="hidden" name="mode" value={mode} /> : null}
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

/**
 * Say which engine served these results, and — when an arm was dropped — what
 * to do about it. Silence would leave the owner guessing why "Smart" behaved
 * exactly like "Exact match".
 */
function EngineBadge({
  engine,
  semanticAvailable,
}: {
  engine: SearchEngineReport;
  semanticAvailable: boolean;
}) {
  if (engine.requested === "portable") return null;

  const label =
    engine.mode === "hybrid"
      ? "Results powered by full-text + vector search"
      : engine.mode === "keyword"
        ? "Results powered by full-text search"
        : "Results powered by substring matching";

  const notes: string[] = [];
  const { keyword, semantic } = engine.arms;
  if (!keyword.used) {
    notes.push(
      keyword.reason === "index_empty"
        ? "The search index is empty — run `netpro reindex` to build it."
        : keyword.reason === "index_missing"
          ? "The full-text index is missing — run `netpro migrate`."
          : "Full-text ranking is unavailable right now.",
    );
  }
  if (engine.requested === "hybrid" && !semantic.used) {
    notes.push(
      semantic.reason === "not_configured"
        ? semanticAvailable
          ? "Semantic ranking is off for this request."
          : "Semantic ranking needs EMBEDDINGS_API_KEY on the server."
        : semantic.reason === "no_embeddings"
          ? "No embeddings stored yet — run `netpro reindex --embeddings`."
          : "The embeddings provider did not respond; lexical results are shown.",
    );
  }
  if (engine.truncated) {
    notes.push("Showing the top candidates only — narrow the query to see more.");
  }

  return (
    <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", opacity: 0.8 }}>
      <span>{label}</span>
      {notes.map((note) => (
        <span key={note} style={{ display: "block" }}>
          {note}
        </span>
      ))}
    </p>
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
