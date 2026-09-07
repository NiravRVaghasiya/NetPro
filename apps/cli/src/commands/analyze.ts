import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  getNetworkOverview,
  type NetworkOverview,
  type ScoreBreakdown,
  type TopValue,
} from "@netpro/core/src/analytics";
import type { NetworkGraph } from "@netpro/core/src/graph";

export interface AnalyzeCommandOptions {
  // Commander stores hyphenated long flags under camelCase keys
  // (`--network-score` -> `networkScore`).
  days?: string;
  dormant?: boolean;
  clusters?: boolean;
  networkScore?: boolean;
  graph?: boolean;
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
export function toAnalyzeOptions(
  opts: AnalyzeCommandOptions,
): { dormantDays: number; limit: number } {
  return {
    dormantDays: parseNumber(opts.days, "days") ?? 90,
    limit: parseNumber(opts.limit, "limit") ?? 10,
    // growthMonths stays at the core default (12); activeDays at 30.
  };
}

/** The four section flags are mutually exclusive; absent all → full report. */
export function selectedSection(
  opts: AnalyzeCommandOptions,
): "score" | "dormant" | "clusters" | "graph" | "full" {
  const sections = [opts.networkScore, opts.dormant, opts.clusters, opts.graph].filter(Boolean);
  if (sections.length > 1) {
    throw new Error(
      "--network-score, --dormant, --clusters, and --graph are mutually exclusive — pick one, or omit all for the full report",
    );
  }
  if (opts.networkScore) return "score";
  if (opts.dormant) return "dormant";
  if (opts.clusters) return "clusters";
  if (opts.graph) return "graph";
  return "full";
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function scoreLine(score: ScoreBreakdown): string[] {
  return [
    `Network score: ${score.score}/100`,
    ...score.factors.map(
      (f) => `  ${f.key.padEnd(9)} ${String(f.value).padStart(5)}/100  (weight ${f.weight})`,
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
      const bar = "█".repeat(Math.max(p.count > 0 ? 1 : 0, Math.round((p.count / max) * width)));
      return `  ${p.month} │ ${bar.padEnd(width, p.count > 0 ? " " : "·")} ${p.count}  (total ${p.cumulative})`;
    }),
  ];
}

export function renderDormantSection(overview: NetworkOverview, dormantDays: number): string[] {
  const lines = [
    `Dormant ties (no known interaction in ${dormantDays}+ days — showing ${overview.dormant.length}):`,
  ];
  if (overview.dormant.length === 0) {
    lines.push("  None — every known touchpoint is inside the window. 🎉");
    return lines;
  }
  for (const d of overview.dormant) {
    const meta = [d.company, d.role].filter(Boolean).join(" · ");
    const score = d.relationshipScore !== null ? ` [score ${d.relationshipScore.toFixed(2)}]` : "";
    lines.push(`  ${d.fullName} — last touch ${d.daysSince}d ago${score}${meta ? `\n     ${meta}` : ""}`);
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
  lines.push(`  Components: ${graph.components.count} (largest ${graph.components.largestSize})${apl}`);

  lines.push("  Most connected:");
  for (const t of graph.centrality.top.slice(0, 5)) {
    const btw = t.betweenness !== null ? ` · betweenness ${t.betweenness.toFixed(2)}` : "";
    lines.push(`    ${t.fullName} — ${t.degree} edge${t.degree === 1 ? "" : "s"}${btw}`);
  }

  if (graph.warmIntros.length > 0) {
    lines.push("  Warm-intro candidates (contact → target, via the strongest intermediary):");
    for (const w of graph.warmIntros.slice(0, 5)) {
      lines.push(`    ${w.contactName} → ${w.targetName} via ${w.viaName} (${w.hops} hops)`);
    }
  }
  if (graph.pendingCandidates > 0) {
    lines.push(
      `  ${graph.pendingCandidates} pending edge candidate${graph.pendingCandidates === 1 ? "" : "s"} excluded from the analysis — review with \`netpro edge list --status pending\`.`,
    );
  }
  return lines;
}

export async function executeAnalyze(
  options: AnalyzeCommandOptions,
  conn: SqliteConn | PgConn,
): Promise<string> {
  const analyticsOptions = toAnalyzeOptions(options);
  const overview = await getNetworkOverview(conn, analyticsOptions);

  if (options.json) {
    return JSON.stringify(overview, null, 2);
  }

  const section = selectedSection(options);

  if (section === "score") {
    return scoreLine(overview.score).join("\n");
  }
  if (section === "dormant") {
    return renderDormantSection(overview, analyticsOptions.dormantDays).join("\n");
  }
  if (section === "clusters") {
    return renderClustersSection(overview).join("\n");
  }
  if (section === "graph") {
    return renderGraphSection(overview.graph).join("\n");
  }

  const m = overview.metrics;
  const g = overview.growth;
  const rate = g.ratePct === null ? "n/a (empty prior window)" : `${g.ratePct > 0 ? "+" : ""}${g.ratePct}%`;
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
    ...renderDormantSection(overview, analyticsOptions.dormantDays),
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Analyze your network: score, growth, diversity, clusters, dormant ties, graph")
    .option("--days <n>", "Dormancy window in days (default 90)", "90")
    .option("--dormant", "Show only the dormant-ties section")
    .option("--clusters", "Show only the clusters section")
    .option("--graph", "Show only the graph-analytics section (v2.0)")
    .option("--network-score", "Print just the network score and its factors")
    .option("--limit <n>", "Max rows per list (default 10)", "10")
    .option("--json", "Print the full overview as JSON")
    .action(async (opts: AnalyzeCommandOptions) => {
      const { openDb } = await import("../db");
      try {
        const output = await executeAnalyze(opts, await openDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro analyze: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
