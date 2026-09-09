// apps/cli/src/commands/content.ts
//
// `netpro content` — the v2.5 Phase 5 cross-posting tracker from the terminal.
//   netpro content list [--platform blog] [--tag js] [--days 30] [--query] [--limit]
//   netpro content add <url> --title "…" [--platform] [--type] [--author] [--tags] [--published-at]
//   netpro content show <id|url> [--metrics [--days 90]]
//   netpro content import <file.csv|feed.xml|feed-url> [--dry-run] [--platform] [--json]
//   netpro content fetch <id|url> [--manual] [--provider <id>] [--views N …] [--json]
//   netpro content rm <id|url>
//   netpro content analyze [--days 30] [--json]
//
// Rendering and flag validation only — parsing, dedupe, snapshots, mentions
// and every write live in @netpro/core/src/content, so the web app and the
// CLI answer identically. The rules the output makes visible: one piece of
// content per normalized URL (re-imports report `existing` and never
// overwrite), snapshots are append-only with `null` meaning "unreported"
// (never zero), and no provider runs without an explicit `fetch` — v2.5
// ships `manual` + `rss`; `devto`/`twitter`/`github` explain what key
// would enable them.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import {
  CONTENT_PROVIDERS,
  ContentError,
  contentStatus,
  deleteContentItem,
  fetchFeedText,
  getContentItem,
  getContentMetricsSeries,
  getContentOverview,
  importContent,
  listContentSummaries,
  recordMetrics,
  resolveContentProviders,
  resolveContentRef,
  upsertContentItem,
  type ContentItem,
  type ContentItemSummary,
  type ContentMetric,
  type ContentOverview,
  type ImportContentSummary,
} from "@netpro/core/src/content";
import { relativeDay, utcDay } from "./track";

// ── flag validation ─────────────────────────────────────────────────────

function parseLimit(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--limit must be a positive number, got "${value}"`);
  }
  return Math.min(Math.floor(n), max);
}

/** `--days` — positive, and capped at the 365-day metrics retention. */
function parseDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--days must be a positive number of days, got "${value}"`);
  }
  return Math.min(Math.floor(n), 365);
}

/** A `--views`-style count: a non-negative integer, or an explicit error. */
function parseCount(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 0 ||
    n > 2_147_483_647
  ) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US");
}

function whenPublished(publishedAt: string | null, now: Date): string {
  if (!publishedAt) return "no date";
  return `${utcDay(publishedAt)} (${relativeDay(publishedAt, now)})`;
}

// ── renderers ───────────────────────────────────────────────────────────

export function renderItemLine(
  item: ContentItem | ContentItemSummary,
  now: Date,
): string {
  const bits = [item.platform];
  if (item.type) bits.push(item.type);
  if (item.author) bits.push(item.author);
  // Engagement rides along when the list answered with summaries: the
  // latest-known views, or likes when the platform does not report views.
  const latest =
    "latestMetrics" in item && item.latestMetrics
      ? item.latestMetrics.views !== null
        ? ` · ${fmt(item.latestMetrics.views)} views`
        : item.latestMetrics.likes !== null
          ? ` · ${fmt(item.latestMetrics.likes)} likes`
          : ""
      : "";
  return `  ${item.title} · ${whenPublished(item.publishedAt, now)} · ${bits.join(" / ")}${latest}  [${item.id.slice(0, 8)}]`;
}

export function renderSnapshot(
  metric: ContentMetric | null | undefined,
  now: Date,
): string {
  if (!metric) {
    return "No metrics yet — record numbers with `netpro content fetch <id|url> --manual --views N …` or add them on /content.";
  }
  const parts = [
    `views ${fmt(metric.views)}`,
    `likes ${fmt(metric.likes)}`,
    `comments ${fmt(metric.comments)}`,
    `shares ${fmt(metric.shares)}`,
    `bookmarks ${fmt(metric.bookmarks)}`,
  ];
  return `Latest snapshot (${utcDay(metric.fetchedAt)}, ${relativeDay(metric.fetchedAt, now)}, ${metric.source}): ${parts.join(" · ")}.`;
}

export function renderItemDetail(
  detail: ContentItemSummary,
  now: Date,
): string {
  const lines = [
    `${detail.title}`,
    `  ${detail.url}`,
    `  platform ${detail.platform}${detail.type ? ` · type ${detail.type}` : ""}${
      detail.author ? ` · by ${detail.author}` : ""
    } · source ${detail.source} · published ${whenPublished(detail.publishedAt, now)}  [${detail.id.slice(
      0,
      8,
    )}]`,
  ];
  if (detail.tags.length > 0) lines.push(`  tags: ${detail.tags.join(", ")}`);
  if (detail.summary) {
    const summary =
      detail.summary.length > 240
        ? `${detail.summary.slice(0, 237)}…`
        : detail.summary;
    lines.push(`  ${summary}`);
  }
  const counts = `  ${detail.metricsCount} snapshot${detail.metricsCount === 1 ? "" : "s"} · ${
    detail.mentionsCount
  } mention${detail.mentionsCount === 1 ? "" : "s"}.`;
  lines.push(`  ${renderSnapshot(detail.latestMetrics, now)}`);
  lines.push(counts);
  return lines.join("\n");
}

export function renderMetricsTable(series: {
  metrics: ContentMetric[];
  total: number;
}): string {
  if (series.metrics.length === 0) {
    return "No snapshots yet.";
  }
  const header =
    "  fetched         source   views     likes   comments  shares   bookmarks";
  const rows = series.metrics.map(
    (m) =>
      `  ${m.fetchedAt.slice(0, 10)}  ${m.source.padEnd(8)} ${String(fmt(m.views)).padStart(8)}  ${String(fmt(m.likes)).padStart(6)}  ${String(fmt(m.comments)).padStart(8)}  ${String(fmt(m.shares)).padStart(6)}  ${String(fmt(m.bookmarks)).padStart(9)}`,
  );
  const tail = `  ${series.metrics.length} of ${series.total} snapshot(s), oldest first.`;
  return [header, ...rows, tail].join("\n");
}

export function renderImportSummary(s: ImportContentSummary): string {
  const head = s.dryRun
    ? `Preview — nothing written. ${s.items} row(s) parsed; ${s.created} new, ${s.existing} already tracked.`
    : `✓ Imported ${s.items} row(s) (${s.created} new, ${s.existing} already tracked).`;
  const lines = [head];
  if (s.feed?.title) {
    lines.push(
      `  feed: ${s.feed.title}${s.feed.link ? ` (${s.feed.link})` : ""}`,
    );
  }
  for (const e of s.errors.slice(0, 10))
    lines.push(`  row ${e.row}: ${e.reason}`);
  for (const w of s.warnings.slice(0, 10))
    lines.push(`  row ${w.row}: ${w.reason}`);
  if (s.errors.length > 10)
    lines.push(`  …and ${s.errors.length - 10} more error(s).`);
  if (s.warnings.length > 10)
    lines.push(`  …and ${s.warnings.length - 10} more warning(s).`);
  return lines.join("\n");
}

export function renderFetchResult(
  metric: ContentMetric,
  item: ContentItem,
): string {
  const parts = [
    `views ${fmt(metric.views)}`,
    `likes ${fmt(metric.likes)}`,
    `comments ${fmt(metric.comments)}`,
    `shares ${fmt(metric.shares)}`,
    `bookmarks ${fmt(metric.bookmarks)}`,
  ].filter((p) => !p.endsWith("—"));
  return `✓ Recorded a ${metric.source} snapshot for "${item.title}": ${parts.join(" · ")} (fetched ${utcDay(metric.fetchedAt)}).`;
}

export function renderOverview(overview: ContentOverview): string {
  // The all-time empty state is onboarding; a *windowed* empty result still
  // answers the question asked ("nothing in the last N days"), so it renders
  // the summary instead of pretending the library is empty.
  if (overview.items === 0 && overview.days === null) {
    return [
      "No content tracked yet. Start with:",
      '  netpro content add https://example.com/post --title "…"',
      "  netpro content import content.csv",
    ].join("\n");
  }
  const window = overview.days === null ? "" : ` (last ${overview.days} days)`;
  const lines = [
    `Content library${window}:`,
    `  ${overview.items} item${overview.items === 1 ? "" : "s"} · ${overview.withMetrics} measured · ${
      overview.snapshots
    } snapshot${overview.snapshots === 1 ? "" : "s"} · ${fmt(overview.totalViews)} latest-known views.`,
  ];
  if (overview.days !== null && overview.excludedUndated > 0) {
    lines.push(
      `  ${overview.excludedUndated} undated item${overview.excludedUndated === 1 ? "" : "s"} ${
        overview.excludedUndated === 1 ? "sits" : "sit"
      } outside the window.`,
    );
  }
  if (overview.top.length === 0) {
    lines.push(
      "  No metrics yet — record numbers with `netpro content fetch <id|url> --manual --views N …`.",
    );
  } else {
    lines.push("  Top performers (by latest-known views):");
    for (const t of overview.top) {
      lines.push(
        `    ${String(fmt(t.latestMetrics?.views ?? null)).padStart(9)} views  ${t.title} · ${t.platform}  [${t.id.slice(0, 8)}]`,
      );
    }
  }
  if (overview.byPlatform.length > 0) {
    lines.push("  By platform:");
    for (const p of overview.byPlatform) {
      lines.push(
        `    ${p.platform.padEnd(9)} ${p.items} item${p.items === 1 ? "" : "s"} · ${fmt(p.views)} latest-known views`,
      );
    }
  }
  return lines.join("\n");
}

// ── executors ───────────────────────────────────────────────────────────

export interface ContentListOptions {
  platform?: string;
  tag?: string;
  days?: string;
  query?: string;
  limit?: string;
  json?: boolean;
}

export async function executeContentList(
  opts: ContentListOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const { items, total, limit } = await listContentSummaries(conn, {
    platform: opts.platform?.trim() || undefined,
    tag: opts.tag?.trim() || undefined,
    days: parseDays(opts.days),
    query: opts.query?.trim() || undefined,
    limit: parseLimit(opts.limit, 50, 200),
    now,
    scope,
  });
  if (opts.json) return JSON.stringify({ items, total, limit }, null, 2);
  if (items.length === 0) {
    return [
      "No content tracked yet. Start with:",
      '  netpro content add https://example.com/my-post --title "My post"',
      "  netpro content import content.csv",
    ].join("\n");
  }
  const lines = [
    `Content (${items.length} of ${total}):`,
    ...items.map((i) => renderItemLine(i, now)),
  ];
  const status = await contentStatus(conn, scope);
  lines.push(
    `  ${status.items} tracked · ${status.withMetrics} with metrics · ${status.snapshots} snapshot(s) · ${status.mentions} mention(s).`,
  );
  return lines.join("\n");
}

export async function executeContentAdd(
  url: string,
  opts: {
    title?: string;
    platform?: string;
    type?: string;
    author?: string;
    tags?: string;
    publishedAt?: string;
    json?: boolean;
  },
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  if (!opts.title?.trim()) {
    throw new Error(
      '--title is required: netpro content add <url> --title "…"',
    );
  }
  const { item, created } = await upsertContentItem(
    conn,
    {
      url,
      title: opts.title,
      platform: opts.platform?.trim() || undefined,
      type: opts.type?.trim() || undefined,
      author: opts.author?.trim() || undefined,
      tags: opts.tags?.trim() || undefined,
      publishedAt: opts.publishedAt?.trim() || undefined,
      source: "manual",
    },
    { now, scope },
  );
  if (opts.json) return JSON.stringify({ item, created }, null, 2);
  return created
    ? `✓ Added "${item.title}" (${item.platform}, ${whenPublished(item.publishedAt, now)})  [${item.id.slice(0, 8)}]`
    : `= "${item.title}" is already tracked (this URL)  [${item.id.slice(0, 8)}] — the existing row is unchanged.`;
}

export interface ContentShowOptions {
  metrics?: boolean;
  days?: string;
  json?: boolean;
}

export async function executeContentShow(
  selector: string,
  opts: ContentShowOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const item = await resolveContentRef(conn, selector, scope);
  const detail = await getContentItem(conn, item.id, scope);
  if (!detail)
    throw new ContentError("not_found", `No content with id "${item.id}".`);
  let series: Awaited<ReturnType<typeof getContentMetricsSeries>> | null = null;
  if (opts.metrics) {
    series = await getContentMetricsSeries(conn, item.id, {
      days: parseDays(opts.days),
      now,
      scope,
    });
  }
  if (opts.json) {
    return JSON.stringify(
      series ? { ...detail, series: series.metrics } : detail,
      null,
      2,
    );
  }
  const lines = [renderItemDetail(detail, now)];
  if (series) lines.push(renderMetricsTable(series));
  return lines.join("\n");
}

export interface ContentImportOptions {
  file?: string;
  dryRun?: boolean;
  platform?: string;
  json?: boolean;
}

export async function executeContentImport(
  positional: string | undefined,
  opts: ContentImportOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const path = (positional ?? opts.file)?.trim();
  if (!path) {
    throw new Error(
      "A file is required: netpro content import content.csv (or --file content.csv)",
    );
  }
  const isUrl = /^https?:\/\//i.test(path);
  const text = isUrl ? await fetchFeedText(path) : readFileSync(path, "utf-8");
  const looksLikeXml = text.trimStart().startsWith("<");
  const summary = await importContent(conn, {
    csv: looksLikeXml ? undefined : text,
    feedXml: looksLikeXml ? text : undefined,
    platform: opts.platform?.trim() || undefined,
    dryRun: opts.dryRun === true,
    now,
    scope,
  });
  if (opts.json) return JSON.stringify(summary, null, 2);
  return renderImportSummary(summary);
}

export interface ContentFetchOptions {
  manual?: boolean;
  provider?: string;
  views?: string;
  likes?: string;
  comments?: string;
  shares?: string;
  bookmarks?: string;
  json?: boolean;
}

function metricSourceFor(
  providerId: string,
): "twitter_api" | "devto_api" | "github_api" {
  if (providerId === "twitter") return "twitter_api";
  if (providerId === "devto") return "devto_api";
  return "github_api";
}

export async function executeContentFetch(
  selector: string,
  opts: ContentFetchOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const item = await resolveContentRef(conn, selector, scope);
  const manualNumbers: Array<[string, number]> = [];
  const counts: Array<[string, string | undefined]> = [
    ["views", opts.views],
    ["likes", opts.likes],
    ["comments", opts.comments],
    ["shares", opts.shares],
    ["bookmarks", opts.bookmarks],
  ];
  for (const [name, raw] of counts) {
    const value = parseCount(raw, name);
    if (value !== undefined) manualNumbers.push([name, value]);
  }

  const wantsManual = opts.manual === true;
  let providerId = opts.provider?.trim().toLowerCase() || null;
  if (providerId && !CONTENT_PROVIDERS.some((p) => p.id === providerId)) {
    throw new Error(
      `Unknown provider "${providerId}". Available: ${CONTENT_PROVIDERS.map((p) => p.id).join(", ")}.`,
    );
  }
  if (wantsManual) {
    if (providerId && providerId !== "manual") {
      throw new Error(
        "--manual and --provider <id> cannot be combined: --manual records the numbers you type in.",
      );
    }
    providerId = "manual";
  }
  if (!providerId) {
    const resolved = resolveContentProviders(item.url)[0];
    providerId = resolved?.id ?? "manual";
  }

  if (providerId === "manual") {
    if (manualNumbers.length === 0) {
      throw new Error(
        "Manual snapshots need at least one number: netpro content fetch <id|url> --manual --views N --likes N …",
      );
    }
    const metric = await recordMetrics(
      conn,
      {
        contentId: item.id,
        views: manualNumbers.find(([n]) => n === "views")?.[1],
        likes: manualNumbers.find(([n]) => n === "likes")?.[1],
        comments: manualNumbers.find(([n]) => n === "comments")?.[1],
        shares: manualNumbers.find(([n]) => n === "shares")?.[1],
        bookmarks: manualNumbers.find(([n]) => n === "bookmarks")?.[1],
        source: "manual",
      },
      { now, scope },
    );
    if (opts.json) return JSON.stringify({ item, metric }, null, 2);
    return renderFetchResult(metric, item);
  }

  const provider = CONTENT_PROVIDERS.find((p) => p.id === providerId)!;
  if (provider.id === "rss") {
    throw new ContentError(
      "not_configured",
      "RSS/Atom feeds carry no engagement numbers — record them by hand with `netpro content fetch <id|url> --manual --views N …`.",
    );
  }
  if (!provider.fetchMetrics) {
    throw new ContentError(
      "not_configured",
      `${provider.name} cannot report metrics for this item yet.`,
    );
  }
  try {
    const sample = await provider.fetchMetrics(item.url);
    const metric = await recordMetrics(
      conn,
      {
        contentId: item.id,
        views: sample.views ?? undefined,
        likes: sample.likes ?? undefined,
        comments: sample.comments ?? undefined,
        shares: sample.shares ?? undefined,
        bookmarks: sample.bookmarks ?? undefined,
        source: metricSourceFor(provider.id),
        rawPayload: sample.rawPayload ?? null,
      },
      { now, scope },
    );
    if (opts.json)
      return JSON.stringify({ item, metric, provider: provider.id }, null, 2);
    return renderFetchResult(metric, item);
  } catch (error) {
    if (error instanceof ContentError && error.code === "not_configured") {
      throw new ContentError(
        "not_configured",
        `${error.message} Record numbers by hand instead with \`netpro content fetch <id|url> --manual --views N …\`.`,
      );
    }
    throw error;
  }
}

export async function executeContentRm(
  selector: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const item = await resolveContentRef(conn, selector, scope);
  const removed = await deleteContentItem(conn, item.id, scope);
  if (opts.json) {
    return JSON.stringify(
      { removed, remaining: (await contentStatus(conn, scope)).items },
      null,
      2,
    );
  }
  return `✗ Removed "${removed.title}" — its snapshots and mentions went with it.`;
}

export interface ContentAnalyzeOptions {
  days?: string;
  json?: boolean;
}

export async function executeContentAnalyze(
  opts: ContentAnalyzeOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const overview = await getContentOverview(conn, {
    days: parseDays(opts.days),
    scope,
    now,
  });
  if (opts.json) return JSON.stringify(overview, null, 2);
  return renderOverview(overview);
}

async function run(
  cmd: Command,
  fn: (conn: SqliteConn | PgConn, scope?: WorkspaceScope) => Promise<string>,
): Promise<void> {
  const { openDb, resolveCliScope } = await import("../db");
  try {
    const conn = await openDb();
    const scope = await resolveCliScope(cmd, conn);
    console.log(await fn(conn, scope));
  } catch (e) {
    console.error(`netpro content: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerContentCommand(program: Command): void {
  const content = program
    .command("content")
    .description(
      "Cross-posting tracker — what you published and how each piece performs (v2.5)",
    );

  content
    .command("list")
    .description("List tracked content, newest-published first")
    .option(
      "--platform <platform>",
      "Filter by platform (blog, devto, x, youtube, …)",
    )
    .option("--tag <tag>", "Filter by exact tag")
    .option("--days <n>", "Only items published in the last N days")
    .option("--query <text>", "Filter by title, URL or author")
    .option("--limit <n>", "Max rows (default 50)", "50")
    .option("--json", "Print the result as JSON")
    .action((opts: ContentListOptions) =>
      run(content, (conn, scope) =>
        executeContentList(opts, conn, new Date(), scope),
      ),
    );

  content
    .command("add <url>")
    .description(
      "Track one piece of content (a duplicate URL is reported, never overwritten)",
    )
    .requiredOption("--title <text>", "Title of the piece")
    .option(
      "--platform <platform>",
      "Platform (default: detected from the URL host, else blog)",
    )
    .option("--type <type>", "article, post, video, thread or repo")
    .option("--author <text>", "Author name")
    .option("--tags <list>", "Comma-separated tags")
    .option("--published-at <date>", "YYYY-MM-DD (or an ISO timestamp)")
    .option("--json", "Print the result as JSON")
    .action(
      (
        url: string,
        opts: {
          title?: string;
          platform?: string;
          type?: string;
          author?: string;
          tags?: string;
          publishedAt?: string;
          json?: boolean;
        },
      ) =>
        run(content, (conn, scope) =>
          executeContentAdd(url, opts, conn, new Date(), scope),
        ),
    );

  content
    .command("show <id|url>")
    .description(
      "Show one piece of content with its latest snapshot (id or exact URL)",
    )
    .option("--metrics", "Also print the snapshot series, oldest first")
    .option("--days <n>", "Window for --metrics (default: all kept snapshots)")
    .option("--json", "Print the result as JSON")
    .action((selector: string, opts: ContentShowOptions) =>
      run(content, (conn, scope) =>
        executeContentShow(selector, opts, conn, new Date(), scope),
      ),
    );

  content
    .command("import [file]")
    .description(
      "Import content from a CSV or an RSS/Atom file (or feed URL) — idempotent",
    )
    .option("--file <path>", "Same as the positional <file> argument")
    .option("--dry-run", "Preview what would be imported, write nothing")
    .option(
      "--platform <platform>",
      "Override the platform for every row (feeds detect per link)",
    )
    .option("--json", "Print the summary as JSON")
    .action((file: string | undefined, opts: ContentImportOptions) =>
      run(content, (conn, scope) =>
        executeContentImport(file, opts, conn, new Date(), scope),
      ),
    );

  content
    .command("fetch <id|url>")
    .description("Fetch fresh engagement numbers for one piece of content")
    .option(
      "--manual",
      "Record the numbers yourself (the only path enabled in v2.5)",
    )
    .option(
      "--provider <id>",
      "Force a provider (devto, twitter, github, rss, manual)",
    )
    .option("--views <n>", "Views, for --manual snapshots")
    .option("--likes <n>", "Likes, for --manual snapshots")
    .option("--comments <n>", "Comments, for --manual snapshots")
    .option("--shares <n>", "Shares, for --manual snapshots")
    .option("--bookmarks <n>", "Bookmarks, for --manual snapshots")
    .option("--json", "Print the result as JSON")
    .action((selector: string, opts: ContentFetchOptions) =>
      run(content, (conn, scope) =>
        executeContentFetch(selector, opts, conn, new Date(), scope),
      ),
    );

  content
    .command("rm <id|url>")
    .description("Remove a piece of content, its snapshots and its mentions")
    .option("--json", "Print the result as JSON")
    .action((selector: string, opts: { json?: boolean }) =>
      run(content, (conn, scope) =>
        executeContentRm(selector, opts, conn, scope),
      ),
    );

  content
    .command("analyze")
    .description(
      "Library at a glance: totals, top performers and platform breakdown",
    )
    .option("--days <n>", "Window the analysis (default: the whole library)")
    .option("--json", "Print the result as JSON")
    .action((opts: ContentAnalyzeOptions) =>
      run(content, (conn, scope) =>
        executeContentAnalyze(opts, conn, new Date(), scope),
      ),
    );
}
