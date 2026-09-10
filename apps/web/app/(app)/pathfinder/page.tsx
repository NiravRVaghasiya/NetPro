// apps/web/app/(app)/pathfinder/page.tsx
//
// Phase 13 — Pathfinder: "Who can introduce me to this person?" as a
// first-class workflow.
//
// The page is a client of the local NetPro server (`GET /api/graph/path`,
// which orchestrates core's `planIntroPaths` — BFS chains ranked by the
// existing path-ranking model) and degrades to the same core call when the
// server is not running. Ranking, scoring, and the first-ask suggestion all
// come from `packages/core/graph/pathfinder.ts`; React only visualizes.
//
// Each ranked chain shows the plan's five facts — path strength, weakest
// relationship, average relationship, number of hops, intermediate contacts —
// as a vertical stepper from origin to target.

import Link from "next/link";
import type { ReactNode } from "react";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import {
  getNetworkGraph,
  introAskText,
  planIntroPaths,
  EDGE_RELATIONS,
  GraphError,
  PATHFINDER_LIMITS,
  type IntroPathPlan,
  type RankedIntroPath,
} from "@netpro/core/src/graph";
import { searchContacts } from "@netpro/core/src/search";
import { graphAnalysisParams } from "@/lib/graph-request";
import { scoreLabel } from "@/lib/format";

export const metadata = { title: "Pathfinder — NetPro" };

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

function draftHref(plan: IntroPathPlan, path: RankedIntroPath): string {
  const text = introAskText(plan, path);
  const p = new URLSearchParams({
    contactId: path.ask.contactId,
    context: text.context,
    purpose: text.purpose,
  });
  return `/outreach?${p.toString()}`;
}

export default async function PathfinderPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const scope = await requireScope();
  const q = await searchParams;
  const serverUrl = getServerUrl();

  const target = one(q.target) ?? one(q.to);
  const from = one(q.from);
  const depth = one(q.depth);
  const alt = one(q.alt) ?? one(q.k);
  const relation = one(q.relation);
  const status = one(q.status);
  const statusLabel =
    status === "all"
      ? "confirmed + pending"
      : status === "pending"
        ? "pending only"
        : "confirmed";

  const analysisInput = new URLSearchParams();
  if (depth) analysisInput.set("depth", depth);
  if (relation) analysisInput.set("relation", relation);
  if (status) analysisInput.set("status", status);
  // Hand-typed URLs must not 500 the page: bad params fall back to defaults.
  let analysis;
  try {
    analysis = graphAnalysisParams(analysisInput);
  } catch {
    analysis = { maxDepth: 4, limit: 10 };
  }
  const altNum = alt === undefined ? NaN : Number(alt);
  const k =
    Number.isFinite(altNum) && altNum >= 1
      ? Math.min(Math.trunc(altNum), PATHFINDER_LIMITS.maxAlternatives)
      : PATHFINDER_LIMITS.defaultAlternatives;

  // ── Contact picklist for the datalist (best-effort, never blocking) ──
  let picklist: Array<{ id: string; fullName: string; company: string | null }> =
    [];
  try {
    const res = await serverFetchJson<{
      contacts?: Array<{ id: string; fullName: string; company: string | null }>;
    }>("/api/search?sort=score&limit=50");
    if (res.ok && Array.isArray(res.data.contacts)) {
      picklist = res.data.contacts;
    }
  } catch {
    picklist = [];
  }
  if (picklist.length === 0) {
    try {
      const local = await searchContacts(
        conn,
        { sort: "score", limit: 50 },
        {},
        scope,
      );
      picklist = local.contacts;
    } catch {
      picklist = [];
    }
  }
  const datalist = (
    <datalist id="netpro-pathfinder-contacts">
      {picklist.map((c) => (
        <option key={c.id} value={c.id}>
          {c.fullName}
          {c.company ? ` — ${c.company}` : ""}
        </option>
      ))}
    </datalist>
  );

  // ── Landing: no target yet ─────────────────────────────────────────
  if (!target) {
    let candidates: Array<{
      contactId: string;
      contactName: string;
      targetId: string;
      targetName: string;
      viaId: string;
      viaName: string;
      hops: number;
    }> = [];
    let nodes = 0;
    let edges = 0;
    try {
      const res = await serverFetchJson<{
        nodes?: number;
        edges?: number;
        warmIntros?: typeof candidates;
      }>("/api/graph");
      if (res.ok) {
        nodes = res.data.nodes ?? 0;
        edges = res.data.edges ?? 0;
        candidates = res.data.warmIntros ?? [];
      } else {
        const g = await getNetworkGraph(conn, { ...analysis, scope });
        nodes = g.nodes;
        edges = g.edges;
        candidates = g.warmIntros;
      }
    } catch {
      try {
        const g = await getNetworkGraph(conn, { ...analysis, scope });
        nodes = g.nodes;
        edges = g.edges;
        candidates = g.warmIntros;
      } catch {
        candidates = [];
      }
    }
    return (
      <div>
        <h1>Pathfinder</h1>
        <p style={{ color: "#475569", maxWidth: 640 }}>
          Who can introduce you to this person? Pick a target and NetPro ranks
          the shortest chains of confirmed links to them — you choose whom to
          ask, NetPro drafts the note (nothing sends itself). Chains are{" "}
          <strong>ranked, never auto-picked</strong>. Server:{" "}
          <code>{serverUrl}</code>
        </p>
        <PathfinderForm
          target={target}
          from={from}
          depth={depth}
          alt={alt}
          relation={relation}
          status={status}
          datalist={datalist}
        />
        {nodes > 0 ? (
          <p style={{ color: "#6b7280" }}>
            {nodes} linked contacts · {edges} confirmed edge
            {edges === 1 ? "" : "s"}
          </p>
        ) : (
          <p style={{ color: "#9ca3af" }}>
            No confirmed edges yet — the pathfinder needs a graph to walk.{" "}
            <Link href="/import">Import connections</Link> or{" "}
            <Link href="/edges">link two people</Link>.
          </p>
        )}
        {candidates.length > 0 ? (
          <section style={{ marginTop: "1rem" }}>
            <h2>Suggested introductions</h2>
            <ul>
              {candidates.map((w) => (
                <li key={`${w.contactId}-${w.targetId}`}>
                  <Link
                    href={`/pathfinder?target=${encodeURIComponent(w.targetId)}&from=${encodeURIComponent(w.contactId)}`}
                  >
                    {w.contactName} → {w.targetName}
                  </Link>{" "}
                  <span style={{ color: "#6b7280" }}>
                    via {w.viaName} ({w.hops} hops)
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  // ── Results: server first, core fallback ───────────────────────────
  let plan: IntroPathPlan | null = null;
  let planError: string | null = null;
  let serverError: string | null = null;
  try {
    const qs = new URLSearchParams({ target });
    if (from) qs.set("from", from);
    if (depth) qs.set("depth", depth);
    if (alt) qs.set("alt", alt);
    if (relation) qs.set("relation", relation);
    if (status) qs.set("status", status);
    const res = await serverFetchJson<IntroPathPlan>(
      `/api/graph/path?${qs.toString()}`,
    );
    if (res.ok) {
      plan = res.data;
    } else if (res.status >= 500) {
      // A broken server falls back to local core; a 4xx is an answer
      // (unknown contact, bad selector) and is rendered as-is below.
      serverError =
        (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    } else {
      planError =
        (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }
  if (!plan && !planError) {
    try {
      plan = await planIntroPaths(
        conn,
        { target, from, k },
        { ...analysis, scope },
      );
    } catch (e) {
      if (e instanceof GraphError) planError = e.message;
      else throw e;
    }
  }

  return (
    <div>
      <h1>Pathfinder</h1>
      <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 0 }}>
        Ranked warm-intro chains — strength, weakest tie, hops, and the first
        ask. Server: <code>{serverUrl}</code>
        {serverError ? (
          <span style={{ color: "#92400e" }}>
            {" "}
            — {serverError} (local fallback)
          </span>
        ) : null}
      </p>
      <PathfinderForm
        target={target}
        from={from}
        depth={depth}
        alt={alt}
        relation={relation}
        status={status}
        datalist={datalist}
      />

      {planError ? (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {planError}
        </p>
      ) : plan ? (
        <section>
          <h2>
            {plan.found
              ? `Paths to ${plan.target.fullName}`
              : `No path to ${plan.target.fullName}`}
          </h2>
          <p style={{ color: "#6b7280", marginTop: "0.25rem" }}>
            From{" "}
            <Link href={`/contacts/${plan.origin.contactId}`}>
              {plan.origin.fullName}
            </Link>
            {plan.origin.selectedBy === "strongest-tie"
              ? ' (your strongest tie — set "From" to pick another)'
              : ""}{" "}
            · max {plan.maxDepth} hop{plan.maxDepth === 1 ? "" : "s"} ·{" "}
            {statusLabel} edges
          </p>
          {!plan.found ? (
            <p>
              Nobody links them within {plan.maxDepth} hops over these edges —{" "}
              <Link href="/edges">add a link or review pending candidates</Link>
              , raise the depth, or include pending candidates.
            </p>
          ) : (
            <div>
              {plan.paths.map((p) => (
                <PathCard key={p.rank} plan={plan as IntroPathPlan} path={p} />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function PathfinderForm({
  target,
  from,
  depth,
  alt,
  relation,
  status,
  datalist,
}: {
  target: string | undefined;
  from: string | undefined;
  depth: string | undefined;
  alt: string | undefined;
  relation: string | undefined;
  status: string | undefined;
  datalist: ReactNode;
}) {
  return (
    <form
      method="get"
      action="/pathfinder"
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        alignItems: "end",
        margin: "1rem 0",
      }}
    >
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          Who do you want to reach?
        </span>
        <input
          name="target"
          defaultValue={target ?? ""}
          list="netpro-pathfinder-contacts"
          placeholder="name, email, or id"
          required
          style={{ padding: "0.4rem", minWidth: 220 }}
        />
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          From (optional)
        </span>
        <input
          name="from"
          defaultValue={from ?? ""}
          list="netpro-pathfinder-contacts"
          placeholder="your strongest tie"
          style={{ padding: "0.4rem", minWidth: 160 }}
        />
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          Depth (1–{PATHFINDER_LIMITS.apiMaxDepth})
        </span>
        <select name="depth" defaultValue={depth ?? "4"}>
          {Array.from({ length: PATHFINDER_LIMITS.apiMaxDepth }, (_, i) =>
            String(i + 1),
          ).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          Alternatives (1–{PATHFINDER_LIMITS.maxAlternatives})
        </span>
        <select
          name="alt"
          defaultValue={alt ?? String(PATHFINDER_LIMITS.defaultAlternatives)}
        >
          {Array.from({ length: PATHFINDER_LIMITS.maxAlternatives }, (_, i) =>
            String(i + 1),
          ).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Relation</span>
        <select name="relation" defaultValue={relation ?? ""}>
          <option value="">any</option>
          {EDGE_RELATIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Edges</span>
        <select name="status" defaultValue={status ?? "confirmed"}>
          <option value="confirmed">confirmed</option>
          <option value="all">confirmed + pending</option>
          <option value="pending">pending only</option>
        </select>
      </label>
      <button type="submit">Find paths</button>
      {datalist}
    </form>
  );
}

/**
 * One ranked chain: the plan's five facts (path strength, weakest
 * relationship, average relationship, hops, intermediaries) plus the vertical
 * stepper and the first ask. All numbers arrive ranked from core — nothing is
 * recomputed or re-sorted here.
 */
function PathCard({
  plan,
  path,
}: {
  plan: IntroPathPlan;
  path: RankedIntroPath;
}) {
  const stats: Array<{ label: string; value: string }> = [
    { label: "Path strength", value: path.score.score.toFixed(2) },
    {
      label: "Weakest relationship",
      value:
        path.score.weakestTie === null
          ? "— (direct)"
          : scoreLabel(path.score.weakestTie),
    },
    {
      label: "Average relationship",
      value: path.score.avgHopStrength.toFixed(2),
    },
    {
      label: "Hops",
      value: `${path.hops} hop${path.hops === 1 ? "" : "s"}`,
    },
    {
      label: "Intermediaries",
      value:
        path.intermediaries.length === 0
          ? "none — direct connection"
          : `${path.intermediaries.length}: ${path.intermediaries.map((n) => n.fullName).join(", ")}`,
    },
  ];
  return (
    <article
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "0.9rem 1rem",
        marginBottom: "0.9rem",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "1.25rem",
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <strong style={{ fontSize: "1.05rem" }}>#{path.rank}</strong>
        {stats.map((s) => (
          <span key={s.label} style={{ fontSize: "0.9rem" }}>
            <span style={{ color: "#6b7280" }}>{s.label}: </span>
            <strong>{s.value}</strong>
          </span>
        ))}
      </div>

      <ol style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0" }}>
        {path.path.map((n, i) => {
          const isOrigin = i === 0;
          const isTarget = i === path.path.length - 1;
          return (
            <li key={n.contactId} style={{ display: "flex", gap: "0.6rem" }}>
              <span
                aria-hidden
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  color: "#9ca3af",
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    marginTop: 4,
                    background: isTarget
                      ? "#16a34a"
                      : isOrigin
                        ? "#2563eb"
                        : "#a78bfa",
                  }}
                />
                {!isTarget ? (
                  <span style={{ flex: 1, width: 2, background: "#e5e7eb" }} />
                ) : null}
              </span>
              <span style={{ paddingBottom: "0.7rem" }}>
                <Link
                  href={`/contacts/${n.contactId}`}
                  style={{ fontWeight: 600, color: "#111827" }}
                >
                  {n.fullName}
                </Link>{" "}
                <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                  {isOrigin
                    ? "· origin"
                    : isTarget
                      ? "· target"
                      : "· intermediary"}
                  {" · "}
                  {scoreLabel(n.relationshipScore)}
                  {n.lastInteraction
                    ? ` · last touch ${n.lastInteraction.slice(0, 10)}`
                    : " · no touch"}
                </span>
                {n.via ? (
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.8rem",
                      color: "#6b7280",
                    }}
                  >
                    via {n.via.relations.join(", ")}
                    {n.via.minConfidence < 1
                      ? ` · confidence ${n.via.minConfidence.toFixed(2)}`
                      : ""}
                    {n.via.oneWay ? " · one-way" : ""}
                  </span>
                ) : null}
                {n.company || n.role ? (
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      color: "#374151",
                    }}
                  >
                    {[n.role, n.company].filter(Boolean).join(" at ")}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <p
        style={{
          margin: "0.25rem 0 0.6rem",
          fontSize: "0.9rem",
          background: "#f9fafb",
          borderRadius: 8,
          padding: "0.45rem 0.7rem",
        }}
      >
        <span style={{ color: "#6b7280" }}>First ask: </span>
        {path.ask.suggestion}
      </p>
      <p style={{ margin: 0 }}>
        <Link
          href={draftHref(plan, path)}
          style={{
            display: "inline-block",
            padding: "0.35rem 0.75rem",
            border: "1px solid #3b82f6",
            borderRadius: 6,
            color: "#1d4ed8",
            textDecoration: "none",
          }}
        >
          Draft intro request to {path.ask.fullName}
        </Link>
      </p>
    </article>
  );
}
