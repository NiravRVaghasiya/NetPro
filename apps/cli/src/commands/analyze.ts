import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import {
  getNetworkOverview,
  type NetworkOverview,
  type ScoreBreakdown,
  type TopValue,
} from "@netpro/core/src/analytics";
import type { NetworkGraph } from "@netpro/core/src/graph";
import type { ViewsOverview } from "@netpro/core/src/views";

export interface AnalyzeCommandOptions {
  // Commander stores hyphenated long flags under camelCase keys
  // (`--network-score` -> `networkScore`).
  days?: string;
  dormant?: boolean;
  clusters?: boolean;
  networkScore?: boolean;
  graph?: boolean;
  // v2.5 Phase 3 — the viewer-analytics section. `--days` doubles as the
  // views window here (default 30, max 90); the include flags opt filtered
  // rows back in.
  views?: boolean;
  includeBots?: boolean;
  includeOwnerViews?: boolean;
  limit?: string;
  json?: boolean;
}

function parseNumber(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n) || n < 1)
    throw new Error(`--${flag} must be a positive number, got "${value}"`);
  return n;
}

/** Build the core analytics options from CLI flags, validating as we go. */
export function toAnalyzeOptions(opts: AnalyzeCommandOptions): {
  dormantDays: number;
  limit: number;
} {
  return {
    dormantDays: parseNumber(opts.days, "days") ?? 90,
    limit: parseNumber(opts.limit, "limit") ?? 10,
    // growthMonths stays at the core default (12); activeDays at 30.
  };
}

/** The five section flags are mutually exclusive; absent all → full report. */
export function selectedSection(
  opts: AnalyzeCommandOptions,
): "score" | "dormant" | "clusters" | "graph" | "views" | "full" {
  const sections = [
    opts.networkScore,
    opts.dormant,
    opts.clusters,
    opts.graph,
    opts.views,
  ].filter(Boolean);
  if (sections.length > 1) {
    throw new Error(
      "--network-score, --dormant, --clusters, --graph, and --views are mutually exclusive — pick one, or omit all for the full report",
    );
  }
  if (opts.networkScore) return "score";
  if (opts.dormant) return "dormant";
  if (opts.clusters) return "clusters";
  if (opts.graph) return "graph";
  if (opts.views) return "views";
  return "full";
}

/**
 * The views window for `--views`: `--days` doubles as the window here
 * (default 30). The core validates the 1–90 retention bound and reports it.
 */
export function toViewsOptions(opts: AnalyzeCommandOptions): {
  days: number;
  limit: number;
  includeBots: boolean;
  includeOwnerViews: boolean;
} {
  return {
    days: parseNumber(opts.days, "days") ?? 30,
    limit: parseNumber(opts.limit, "limit") ?? 10,
    includeBots: opts.includeBots ?? false,
    includeOwnerViews: opts.includeOwnerViews ?? false,
  };
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function scoreLine(score: ScoreBreakdown): string[] {
  return [
    `Network score: ${score.score}/100`,
    ...score.factors.map(
      (f) =>
        `  ${f.key.padEnd(9)} ${String(f.value).padStart(5)}/100  (weight ${f.weight})`,
    ),
  ];
}

function topValuesLines(title: string, values: TopValue[]): string[] {
  if (values.length === 0) return [];
  return [
    title,
    ...values.map((v) => `  ${v.value}  ${v.count} (${pct(v.share)})`),
  ];
}

/** `2026-05 │ ████ 4  (total 45)` — bar scaled to the busiest month. */
function growthLines(overview: NetworkOverview): string[] {
  const series = overview.growth.series;
  if (series.length === 0) return [];
  const max = Math.max(...series.map((p) => p.count), 1);
  const width = 20;
  return [
    "",
    "Growth (new connections per month):",
    ...series.map((p) => {
      const bar = "█".repeat(
        Math.max(p.count > 0 ? 1 : 0, Math.round((p.count / max) * width)),
      );
      return `  ${p.month} │ ${bar.padEnd(width, p.count > 0 ? " " : "·")} ${p.count}  (total ${p.cumulative})`;
    }),
  ];
}

export function renderDormantSection(
  overview: NetworkOverview,
  dormantDays: number,
): string[] {
  const lines = [
    `Dormant ties (no known interaction in ${dormantDays}+ days — showing ${overview.dormant.length}):`,
  ];
  if (overview.dormant.length === 0) {
    lines.push("  None — every known touchpoint is inside the window. 🎉");
    return lines;
  }
  for (const d of overview.dormant) {
    const meta = [d.company, d.role].filter(Boolean).join(" · ");
    const score =
      d.relationshipScore !== null
        ? ` [score ${d.relationshipScore.toFixed(2)}]`
        : "";
    lines.push(
      `  ${d.fullName} — last touch ${d.daysSince}d ago${score}${meta ? `\n     ${meta}` : ""}`,
    );
  }
  return lines;
}

export function renderClustersSection(overview: NetworkOverview): string[] {
  const lines = ["Clusters (contacts grouped by company):"];
  if (overview.clusters.length === 0) {
    lines.push("  No company data yet — import connections or run enrichment.");
    return lines;
  }
  for (const c of overview.clusters) {
    const roles = c.topRoles
      .slice(0, 3)
      .map((r) => `${r.value} (${r.count})`)
      .join(", ");
    lines.push(
      `  ${c.label} — ${c.size} contact${c.size === 1 ? "" : "s"} (${pct(c.share)})${roles ? `\n     roles: ${roles}` : ""}`,
    );
  }
  return lines;
}

/** v2.0 Phase 2 — the graph-analytics strip in text form. */
export function renderGraphSection(graph: NetworkGraph | undefined): string[] {
  if (!graph) return [];
  if (graph.degraded) {
    return ["Network graph:", `  ${graph.degraded.reason}`];
  }
  if (graph.nodes === 0) {
    const pending =
      graph.pendingCandidates > 0
        ? ` ${graph.pendingCandidates} pending candidate${graph.pendingCandidates === 1 ? "" : "s"} to review with \`netpro edge list --status pending\`.`
        : "";
    return [
      "Network graph:",
      `  No confirmed edges yet — link people with \`netpro edge add "A" "B"\`;${pending}`,
    ];
  }

  const lines = [
    `Network graph (${graph.nodes} of ${graph.totalContacts} contacts linked · ${graph.edges} edges):`,
    `  Communities: ${graph.communities.count} (modularity ${graph.communities.modularity})`,
  ];
  for (const c of graph.communities.top.slice(0, 5)) {
    const names = c.members.map((m) => m.fullName).join(", ");
    lines.push(
      `    ${c.label} — ${c.size} ${c.size === 1 ? "person" : "people"}${names ? `: ${names}${c.truncated ? "…" : ""}` : ""}`,
    );
  }

  const apl =
    graph.avgPathLength.value !== null
      ? ` · avg path length ${graph.avgPathLength.value.toFixed(2)}`
      : graph.avgPathLength.note
        ? " · avg path length n/a (over the exact-BFS budget)"
        : "";
  lines.push(
    `  Components: ${graph.components.count} (largest ${graph.components.largestSize})${apl}`,
  );

  lines.push("  Most connected:");
  for (const t of graph.centrality.top.slice(0, 5)) {
    const btw =
      t.betweenness !== null
        ? ` · betweenness ${t.betweenness.toFixed(2)}`
        : "";
    lines.push(
      `    ${t.fullName} — ${t.degree} edge${t.degree === 1 ? "" : "s"}${btw}`,
    );
  }

  if (graph.warmIntros.length > 0) {
    lines.push(
      "  Warm-intro candidates (contact → target, via the strongest intermediary):",
    );
    for (const w of graph.warmIntros.slice(0, 5)) {
      lines.push(
        `    ${w.contactName} → ${w.targetName} via ${w.viaName} (${w.hops} hops)`,
      );
    }
  }
  if (graph.pendingCandidates > 0) {
    lines.push(
      `  ${graph.pendingCandidates} pending edge candidate${graph.pendingCandidates === 1 ? "" : "s"} excluded from the analysis — review with \`netpro edge list --status pending\`.`,
    );
  }
  return lines;
}

/** One stored referrer → its host for compact display (`null` → direct). */
function referrerHost(referrer: string | null): string {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).host.toLowerCase();
    return host || referrer;
  } catch {
    return referrer;
  }
}

/** v2.5 Phase 3 — the viewer-analytics strip in text form (shared with `netpro card --views`). */
export function renderViewsSection(
  views: ViewsOverview | undefined,
  days: number,
): string[] {
  if (!views) return [];
  const { stats, recent, matches } = views;
  const t = stats.totals;
  if (t.views === 0) {
    const lines = [
      `Profile views (last ${days} days):`,
      "  No views yet — publish your card and share the link; views appear here.",
    ];
    if (stats.excluded.bots > 0 || stats.excluded.ownerViews > 0) {
      lines.push(
        `  (${excludedNote(stats.excluded.bots, stats.excluded.ownerViews)} — nothing from real visitors.)`,
      );
    }
    return lines;
  }

  const visitors =
    matches.total === 0
      ? "no known visitors yet"
      : `${matches.total} known-visitor view${matches.total === 1 ? "" : "s"}`;
  const lines = [
    `Profile views (last ${days} days):`,
    `  ${t.views} view${t.views === 1 ? "" : "s"} · ${t.uniqueViewers} unique viewer${t.uniqueViewers === 1 ? "" : "s"} · ${visitors}`,
  ];
  if (stats.excluded.bots > 0 || stats.excluded.ownerViews > 0) {
    lines.push(
      `  ${excludedNote(stats.excluded.bots, stats.excluded.ownerViews)} (use --include-bots / --include-owner-views to count them)`,
    );
  }
  if (t.avgDurationMs !== null) {
    lines.push(`  Avg read duration: ${formatDuration(t.avgDurationMs)}`);
  }

  const active = stats.series.filter((p) => p.views > 0);
  if (active.length > 0) {
    const max = Math.max(...active.map((p) => p.views));
    const width = 20;
    lines.push("", "Views per day:");
    for (const p of active) {
      const bar = "█".repeat(Math.max(1, Math.round((p.views / max) * width)));
      lines.push(`  ${p.date} │ ${bar} ${p.views}`);
    }
  }

  if (stats.byReferrer.length > 0) {
    lines.push(
      "",
      "Top referrers:",
      ...stats.byReferrer.map(
        (r) => `  ${r.value}  ${r.count} (${pct(r.share)})`,
      ),
    );
  }
  if (stats.byCountry.length > 0) {
    lines.push(
      "",
      "Top countries:",
      ...stats.byCountry.map(
        (r) => `  ${r.value}  ${r.count} (${pct(r.share)})`,
      ),
    );
  }

  lines.push(
    "",
    `Recent views (showing ${recent.views.length} of ${recent.total}):`,
  );
  for (const v of recent.views) {
    const who = v.resolvedContact ? v.resolvedContact.fullName : "anonymous";
    const where = [v.country, referrerHost(v.referrer)].filter(
      (s) => s && s !== "direct",
    );
    lines.push(
      `  ${v.viewedAt.slice(0, 16).replace("T", " ")}  ${v.viewedPage}  ${who}${where.length > 0 ? `  (${where.join(" · ")})` : ""}`,
    );
  }

  if (matches.matches.length > 0) {
    lines.push(
      "",
      `Known visitors (${matches.total} view${matches.total === 1 ? "" : "s"}):`,
    );
    for (const m of matches.matches) {
      const meta = m.contact.company ? ` (${m.contact.company})` : "";
      lines.push(
        `  ${m.contact.fullName}${meta} — ${m.viewedAt.slice(0, 10)} via ${referrerHost(m.referrer)}`,
      );
    }
    if (matches.total > matches.matches.length) {
      lines.push(
        `  …and ${matches.total - matches.matches.length} more (raise --limit to see them)`,
      );
    }
  }
  return lines;
}

function excludedNote(bots: number, ownerViews: number): string {
  const parts: string[] = [];
  if (bots > 0) parts.push(`${bots} bot view${bots === 1 ? "" : "s"} excluded`);
  if (ownerViews > 0)
    parts.push(
      `${ownerViews} owner view${ownerViews === 1 ? "" : "s"} excluded`,
    );
  return parts.join(" · ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export async function executeAnalyze(
  options: AnalyzeCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const analyticsOptions = { ...toAnalyzeOptions(options), scope };
  const section = selectedSection(options);

  // Every section reads the same overview payload. `--views` applies the
  // requested window to its views block so text and `--json` always agree;
  // the full report keeps the default 30-day block (its `--days` is the
  // dormancy window — reusing it here would break `analyze --days 365`,
  // which is valid today and must stay valid).
  const overview = await getNetworkOverview(conn, {
    ...analyticsOptions,
    views:
      section === "views"
        ? toViewsOptions(options)
        : options.includeBots || options.includeOwnerViews
          ? {
              includeBots: options.includeBots,
              includeOwnerViews: options.includeOwnerViews,
            }
          : undefined,
  });

  if (options.json) {
    return JSON.stringify(overview, null, 2);
  }

  if (section === "views") {
    return renderViewsSection(
      overview.views,
      toViewsOptions(options).days,
    ).join("\n");
  }

  if (section === "score") {
    return scoreLine(overview.score).join("\n");
  }
  if (section === "dormant") {
    return renderDormantSection(overview, analyticsOptions.dormantDays).join(
      "\n",
    );
  }
  if (section === "clusters") {
    return renderClustersSection(overview).join("\n");
  }
  if (section === "graph") {
    return renderGraphSection(overview.graph).join("\n");
  }

  const m = overview.metrics;
  const g = overview.growth;
  const rate =
    g.ratePct === null
      ? "n/a (empty prior window)"
      : `${g.ratePct > 0 ? "+" : ""}${g.ratePct}%`;
  const lines = [
    ...scoreLine(overview.score),
    "",
    `Contacts: ${m.totalContacts} total · ${m.activeConnections} active (30d) · ${m.dormantConnections} dormant (${analyticsOptions.dormantDays}d+)`,
    `Avg relationship score: ${m.avgRelationshipScore === null ? "–" : m.avgRelationshipScore}`,
    `Diversity: ${m.diversityEffective} effective ${m.diversityField} categories · ${m.companiesDistinct} companies · ${m.industriesDistinct} industries`,
    "",
    `Growth (last 30 days): +${g.last30} (${rate} vs prior 30d)`,
    ...growthLines(overview),
    ...topValuesLines("Top companies:", overview.topCompanies),
    ...topValuesLines("Top industries:", overview.topIndustries),
    "",
    ...renderClustersSection(overview),
    "",
    ...renderGraphSection(overview.graph),
    "",
    ...renderViewsSection(overview.views, 30),
    "",
    ...renderDormantSection(overview, analyticsOptions.dormantDays),
  ];
  return lines
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description(
      "Analyze your network: score, growth, diversity, clusters, dormant ties, graph, views",
    )
    .option(
      "--days <n>",
      "Dormancy window in days (default 90; the views window, default 30, with --views)",
    )
    .option("--dormant", "Show only the dormant-ties section")
    .option("--clusters", "Show only the clusters section")
    .option("--graph", "Show only the graph-analytics section (v2.0)")
    .option("--views", "Show only the profile-views section (v2.5)")
    .option("--include-bots", "Count bot views too (views output)")
    .option("--include-owner-views", "Count your own views too (views output)")
    .option("--network-score", "Print just the network score and its factors")
    .option("--limit <n>", "Max rows per list (default 10)", "10")
    .option("--json", "Print the full overview as JSON")
    .action(async (opts: AnalyzeCommandOptions, cmd: Command) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const output = await executeAnalyze(opts, conn, scope);
        console.log(output);
      } catch (e) {
        console.error(`netpro analyze: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
