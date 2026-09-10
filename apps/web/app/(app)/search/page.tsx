// apps/web/app/(app)/search/page.tsx
//
// Phase 12 — Search experience: NetPro's hybrid search behind a clear,
// server-driven interface.
//
// The page is a client of the local NetPro server (`GET /api/search`, which
// orchestrates `packages/core/search` — portable/portable+FTS/hybrid with RRF
// fusion stay in core) and degrades to the same core call when the server is
// not running, so `next dev` without `netpro serve` keeps working.
//
// Filters cover the plan's list — Name, Company, Role, Location, Skills,
// Tags, Relationship strength, Community (plus the pre-existing Industry,
// Seniority, Has-email, and recency refinements) — and every hit explains
// itself ("Matched because ✓ …") with core's pure `explainMatch`, the same
// lines `netpro search --explain` prints.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import {
  explainMatch,
  isSearchMode,
  searchContacts,
  type ContactSearchResult,
  type FacetBucket,
  type MatchReason,
  type SearchContactsOptions,
  type SearchEngineReport,
  type SearchFacets,
} from "@netpro/core/src/search";
import { searchEmbedder, semanticSearchAvailable } from "@/lib/search-config";
import { providerEnvironment, providerStatusEnvironment } from "@/lib/vault";

export const metadata = { title: "Search — NetPro" };

type SearchParams = Record<string, string | string[] | undefined>;

type SearchHit = ContactSearchResult & { matchReasons?: MatchReason[] };

type SearchResults = {
  contacts: SearchHit[];
  total: number;
  limit: number;
  offset: number;
  facets: SearchFacets;
  engine: SearchEngineReport;
};

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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
const MIN_SCORES = [
  { value: "", label: "Any strength" },
  { value: "0.3", label: "0.3+ (warming up)" },
  { value: "0.5", label: "0.5+ (solid)" },
  { value: "0.7", label: "0.7+ (strong)" },
  { value: "0.9", label: "0.9+ (inner circle)" },
];

/** Every filter the page reads — sort/facet/pagination links preserve all of them. */
const PARAM_KEYS = [
  "q",
  "name",
  "company",
  "role",
  "location",
  "industry",
  "seniority",
  "skills",
  "tags",
  "community",
  "minScore",
  "activeWithin",
  "sort",
  "limit",
  "mode",
];

function buildParams(
  sp: SearchParams,
  override: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  const current: Record<string, string | undefined> = {};
  for (const k of PARAM_KEYS) current[k] = one(sp[k]);
  if (one(sp["hasEmail"]) === "true") current.hasEmail = "true";
  if (one(sp["offset"])) current.offset = one(sp["offset"]);
  Object.assign(current, override);
  for (const [k, v] of Object.entries(current)) {
    if (v !== undefined && v !== "") params.set(k, v);
  }
  return params.toString();
}

function scoreTone(score: number | null): string {
  if (score === null) return "#6b7280";
  if (score >= 0.7) return "#15803d";
  if (score >= 0.4) return "#a16207";
  return "#6b7280";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const scope = await requireScope();
  const sp = await searchParams;
  const serverUrl = getServerUrl();

  const limitRaw = Number(one(sp.limit) ?? "25");
  const offsetRaw = Number(one(sp.offset) ?? "0");
  const limit = Number.isNaN(limitRaw) ? 25 : limitRaw;
  const offset = Number.isNaN(offsetRaw) ? 0 : offsetRaw;

  // An unrecognised ?mode= is ignored rather than 400-ing the page — a stale
  // bookmark should still render results, and the engine badge reports what
  // actually ran.
  const requestedMode = one(sp.mode);
  const mode = isSearchMode(requestedMode) ? requestedMode : undefined;

  // Hand-typed URLs must not 500 the page: unparseable numbers degrade to
  // "no filter", exactly as the server route treats them.
  const minScoreRaw = one(sp.minScore);
  const minScoreNum =
    minScoreRaw === undefined || minScoreRaw === ""
      ? undefined
      : Number(minScoreRaw);
  const minScore =
    minScoreNum !== undefined &&
    Number.isFinite(minScoreNum) &&
    minScoreNum >= 0 &&
    minScoreNum <= 1
      ? minScoreNum
      : undefined;
  const activeWithinRaw = one(sp.activeWithin);
  const activeWithinNum =
    activeWithinRaw === undefined || activeWithinRaw === ""
      ? undefined
      : Number(activeWithinRaw);
  const activeWithin =
    activeWithinNum !== undefined &&
    Number.isFinite(activeWithinNum) &&
    activeWithinNum > 0
      ? Math.trunc(activeWithinNum)
      : undefined;

  const options: SearchContactsOptions = {
    query: one(sp.q),
    name: one(sp.name),
    company: one(sp.company),
    role: one(sp.role),
    location: one(sp.location),
    industry: one(sp.industry),
    seniority: one(sp.seniority),
    hasEmail: one(sp.hasEmail) === "true",
    minScore,
    lastActiveWithinDays: activeWithin,
    skills: splitList(one(sp.skills)),
    tags: splitList(one(sp.tags)),
    community: one(sp.community),
    sort: (one(sp.sort) as SearchContactsOptions["sort"]) ?? "relevance",
    limit,
    offset,
    mode,
  };

  const embeddingEnv =
    mode === "hybrid"
      ? await providerEnvironment(["embeddings.openai", "outreach.openai"])
      : await providerStatusEnvironment([
          "embeddings.openai",
          "outreach.openai",
        ]);
  const semanticAvailable = semanticSearchAvailable(embeddingEnv);

  // ── Server first, core fallback ────────────────────────────────────
  let results: SearchResults | null = null;
  let serverError: string | null = null;
  let communityLabels: string[] = [];
  try {
    const qs = new URLSearchParams();
    const set = (k: string, v: string | undefined): void => {
      if (v !== undefined && v !== "") qs.set(k, v);
    };
    set("q", options.query);
    set("name", options.name);
    set("company", options.company);
    set("role", options.role);
    set("location", options.location);
    set("industry", options.industry);
    set("seniority", options.seniority);
    if (options.hasEmail) qs.set("hasEmail", "true");
    if (minScore !== undefined) qs.set("minScore", String(minScore));
    if (activeWithin !== undefined) qs.set("activeWithin", String(activeWithin));
    if (options.skills) qs.set("skills", options.skills.join(","));
    if (options.tags) qs.set("tags", options.tags.join(","));
    set("community", options.community);
    set("sort", options.sort);
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    if (mode) qs.set("mode", mode);
    const res = await serverFetchJson<SearchResults>(
      `/api/search?${qs.toString()}`,
    );
    if (res.ok) {
      results = res.data;
      // Best-effort community labels for the datalist — the filter itself
      // works with any label, id, or `Community N` typed by hand.
      try {
        const g = await serverFetchJson<{
          communities?: { top?: Array<{ label: string }> };
        }>("/api/graph");
        if (g.ok) {
          communityLabels = (g.data.communities?.top ?? []).map((c) => c.label);
        }
      } catch {
        communityLabels = [];
      }
    } else {
      serverError =
        (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }
  if (!results) {
    const fallback = await searchContacts(
      conn,
      options,
      mode === "hybrid" ? { embedder: searchEmbedder(embeddingEnv) } : {},
      scope,
    );
    results = {
      ...fallback,
      contacts: fallback.contacts.map((c) => ({
        ...c,
        matchReasons: explainMatch(c, options),
      })),
    };
  }
  const activeSort = options.sort ?? "relevance";

  return (
    <div>
      <h1>Search</h1>
      <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 0 }}>
        Hybrid people search — name, company, role, location, skills, tags,
        relationship strength, community. Server: <code>{serverUrl}</code>
        {serverError ? (
          <span style={{ color: "#92400e" }}>
            {" "}
            — {serverError} (local fallback)
          </span>
        ) : null}
      </p>

      <form method="GET" action="/search">
        <input
          type="search"
          name="q"
          placeholder="Search by name, company, role, email…"
          defaultValue={options.query ?? ""}
          aria-label="Search contacts"
        />
        <select
          name="mode"
          defaultValue={mode ?? "portable"}
          aria-label="Search engine"
        >
          <option value="portable">Exact match</option>
          <option value="keyword">Smart (full-text)</option>
          {/* Only offered when a key is configured: a toggle that silently
              does nothing is worse than no toggle. */}
          {semanticAvailable ? (
            <option value="hybrid">Smart + semantic</option>
          ) : null}
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
          alignItems: "end",
        }}
      >
        {/* Preserve the free-text query, engine, and sort across filter changes. */}
        <input type="hidden" name="q" value={options.query ?? ""} />
        {mode ? <input type="hidden" name="mode" value={mode} /> : null}
        <input type="hidden" name="sort" value={activeSort} />
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Name</span>
          <input
            name="name"
            placeholder="Full name"
            defaultValue={options.name ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Company</span>
          <input
            name="company"
            placeholder="Company"
            defaultValue={options.company ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Role</span>
          <input
            name="role"
            placeholder="Role"
            defaultValue={options.role ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Location</span>
          <input
            name="location"
            placeholder="Location"
            defaultValue={options.location ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Industry</span>
          <input
            name="industry"
            placeholder="Industry"
            defaultValue={options.industry ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Skills</span>
          <input
            name="skills"
            placeholder="python, kubernetes"
            defaultValue={options.skills?.join(", ") ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Tags</span>
          <input
            name="tags"
            placeholder="founder, ai"
            defaultValue={options.tags?.join(", ") ?? ""}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Community
          </span>
          <input
            name="community"
            placeholder="Label, Community N, or id"
            defaultValue={options.community ?? ""}
            list="netpro-communities"
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Relationship strength
          </span>
          <select
            name="minScore"
            defaultValue={minScore !== undefined ? String(minScore) : ""}
          >
            {MIN_SCORES.map((s) => (
              <option key={s.label} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Active within (days)
          </span>
          <input
            name="activeWithin"
            placeholder="e.g. 30"
            defaultValue={one(sp.activeWithin) ?? ""}
            inputMode="numeric"
            style={{ width: 110 }}
          />
        </label>
        <label style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Seniority
          </span>
          <select name="seniority" defaultValue={options.seniority ?? ""}>
            <option value="">Any seniority</option>
            {SENIORITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
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
        <datalist id="netpro-communities">
          {communityLabels.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
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
            <div>
              {results.contacts.map((c) => (
                <SearchHitCard key={c.id} hit={c} />
              ))}
            </div>
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

function SearchHitCard({ hit }: { hit: SearchHit }) {
  const meta = [hit.company, hit.role].filter(Boolean).join(" · ");
  const reasons = hit.matchReasons ?? [];
  return (
    <article
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <Link
          href={`/contacts/${hit.id}`}
          style={{ fontWeight: 600, color: "#111827", fontSize: "1.05rem" }}
        >
          {hit.fullName}
        </Link>
        <span
          style={{
            fontSize: "0.8rem",
            color: scoreTone(hit.relationshipScore),
            border: `1px solid ${scoreTone(hit.relationshipScore)}33`,
            borderRadius: 999,
            padding: "0.05rem 0.5rem",
          }}
          title="Relationship strength"
        >
          {hit.relationshipScore !== null
            ? `strength ${hit.relationshipScore.toFixed(2)}`
            : "no score yet"}
        </span>
        {hit.location ? (
          <span style={{ fontSize: "0.85rem", color: "#6b7280" }}>
            {hit.location}
          </span>
        ) : null}
      </div>
      {meta ? (
        <p style={{ margin: "0.25rem 0 0", color: "#374151" }}>{meta}</p>
      ) : null}
      {hit.email ? (
        <p style={{ margin: "0.15rem 0 0", fontSize: "0.85rem", color: "#6b7280" }}>
          {hit.email}
        </p>
      ) : null}
      {(hit.skills?.length ?? 0) + (hit.tags?.length ?? 0) > 0 ? (
        <p
          style={{
            margin: "0.4rem 0 0",
            display: "flex",
            gap: "0.3rem",
            flexWrap: "wrap",
          }}
        >
          {(hit.skills ?? []).map((s) => (
            <span
              key={`skill-${s}`}
              style={{
                fontSize: "0.75rem",
                background: "#eff6ff",
                color: "#1d4ed8",
                borderRadius: 999,
                padding: "0.1rem 0.55rem",
              }}
            >
              {s}
            </span>
          ))}
          {(hit.tags ?? []).map((t) => (
            <span
              key={`tag-${t}`}
              style={{
                fontSize: "0.75rem",
                background: "#f5f3ff",
                color: "#6d28d9",
                borderRadius: 999,
                padding: "0.1rem 0.55rem",
              }}
            >
              #{t}
            </span>
          ))}
        </p>
      ) : null}
      {reasons.length > 0 ? (
        <div
          style={{
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "#374151",
            background: "#f9fafb",
            borderRadius: 8,
            padding: "0.45rem 0.7rem",
          }}
        >
          <span style={{ color: "#6b7280" }}>Matched because:</span>
          <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
            {reasons.map((r) => (
              <li key={r.text}>✓ {r.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
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
    notes.push(
      "Showing the top candidates only — narrow the query to see more.",
    );
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
