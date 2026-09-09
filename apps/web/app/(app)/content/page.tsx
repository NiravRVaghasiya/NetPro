// apps/web/app/(app)/content/page.tsx
//
// v2.5 Phase 5 — the cross-posting tracker. Server-rendered and GET-form
// driven, the house pattern: every number comes from the same core functions
// the CLI uses, and nothing here needs a provider key or a network call.
//
//   * the list — everything you track, filtered by platform/tag/window/query;
//   * the overview — top performers by latest-known views and the platform
//     breakdown (the same `getContentOverview` the dashboard strip reads);
//   * the panels — add one link, or import a CSV/feed preview-then-write.
import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  CONTENT_PLATFORMS,
  contentStatus,
  getContentOverview,
  listContentSummaries,
  type ContentItemSummary,
  type ContentOverview,
} from "@netpro/core/src/content";
import { relativeDayLabel, utcDay } from "@/lib/format";
import { formatCount, platformLabel } from "@/lib/content";
import { AddContentForm, ImportContentPanel } from "./panels";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

function num(value: string | string[] | undefined): number | undefined {
  const s = one(value);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.trunc(n), 1), 365)
    : undefined;
}

function published(publishedAt: string | null, now: Date): string {
  return publishedAt
    ? `${utcDay(publishedAt)} (${relativeDayLabel(publishedAt, now)})`
    : "no date";
}

function MetricBits({ item }: { item: ContentItemSummary }) {
  const latest = item.latestMetrics;
  if (!latest) {
    return <span style={{ color: "#9ca3af" }}>no snapshots yet</span>;
  }
  const bits = [
    latest.views !== null ? `${formatCount(latest.views)} views` : null,
    latest.likes !== null ? `${formatCount(latest.likes)} likes` : null,
    item.metricsCount > 1 ? `${item.metricsCount} snapshots` : null,
  ].filter(Boolean);
  return (
    <span style={{ color: "#6b7280" }}>
      {bits.length > 0 ? bits.join(" · ") : "reported, no views/likes"}
    </span>
  );
}

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const q = await searchParams;
  const sp = new URLSearchParams();
  const platform = one(q.platform);
  const tag = one(q.tag);
  const days = num(q.days);
  const query = one(q.query);
  if (platform) sp.set("platform", platform);
  if (tag) sp.set("tag", tag);
  if (days) sp.set("days", String(days));
  if (query) sp.set("query", query);

  const now = new Date();
  const scope = await requireScope();
  const listOptions = { platform, tag, days, query, limit: 100, scope };
  const [list, overview, status] = await Promise.all([
    listContentSummaries(conn, listOptions),
    getContentOverview(conn, { days, now, scope }),
    contentStatus(conn, scope),
  ]);

  const windowLabel = days ? ` (last ${days} days)` : "";

  return (
    <div>
      <h1>Content</h1>
      <p style={{ color: "#475569" }}>
        Everything you publish and how each piece performs — blog, dev.to,
        Twitter/X, GitHub and the rest, in one library. Metrics are snapshots
        you record (or a provider fetches later); nothing here calls a platform
        without your say-so.
      </p>
      <p style={{ color: "#6b7280" }}>
        {status.items} item{status.items === 1 ? "" : "s"} ·{" "}
        {status.withMetrics} measured · {status.snapshots} snapshot
        {status.snapshots === 1 ? "" : "s"}
        {overview.excludedUndated > 0 && days
          ? ` · ${overview.excludedUndated} undated outside the window`
          : ""}
        .
      </p>

      <form
        method="get"
        action="/content"
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "center",
          margin: "1rem 0",
        }}
      >
        <select
          name="platform"
          defaultValue={platform ?? ""}
          style={{ padding: "0.4rem" }}
        >
          <option value="">all platforms</option>
          {CONTENT_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {platformLabel(p)}
            </option>
          ))}
        </select>
        <select
          name="days"
          defaultValue={days ? String(days) : ""}
          style={{ padding: "0.4rem" }}
        >
          <option value="">any time</option>
          <option value="7">last 7 days</option>
          <option value="30">last 30 days</option>
          <option value="90">last 90 days</option>
        </select>
        <input
          name="tag"
          defaultValue={tag ?? ""}
          placeholder="Tag (exact)"
          maxLength={50}
          style={{ padding: "0.4rem", width: "9rem" }}
        />
        <input
          name="query"
          defaultValue={query ?? ""}
          placeholder="Title, URL or author"
          maxLength={200}
          style={{ padding: "0.4rem", width: "12rem" }}
        />
        <button type="submit">Filter</button>
        {platform || tag || days || query ? (
          <Link href="/content">Clear</Link>
        ) : null}
      </form>

      {list.total === 0 ? (
        <p style={{ color: "#9ca3af" }}>
          No content here{windowLabel} yet — track your first piece below,
          import a CSV or an RSS/Atom feed, and snapshots will start telling you
          what performs.
        </p>
      ) : (
        <>
          <p style={{ color: "#6b7280" }}>
            Showing {list.items.length} of {list.total}.
          </p>
          <table
            data-testid="content-table"
            style={{ borderCollapse: "collapse", width: "100%" }}
          >
            <thead>
              <tr
                style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}
              >
                <th style={{ padding: "0.4rem 0.5rem" }}>Piece</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Platform</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Published</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Latest</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.4rem 0.5rem" }}>
                    <Link href={`/content/${encodeURIComponent(item.id)}`}>
                      {item.title}
                    </Link>
                    {item.author ? (
                      <div style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                        {item.author}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#374151" }}>
                    {platformLabel(item.platform)}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>
                    {published(item.publishedAt, now)}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem" }}>
                    <MetricBits item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Overview windowLabel={windowLabel} overview={overview} />

      <AddContentForm />
      <ImportContentPanel />
    </div>
  );
}

function Overview({
  windowLabel,
  overview,
}: {
  windowLabel: string;
  overview: ContentOverview;
}) {
  if (overview.items === 0 && !windowLabel) return null;
  return (
    <section style={{ marginTop: "1.75rem" }}>
      <h2>At a glance{windowLabel}</h2>
      <p style={{ color: "#6b7280", margin: "0.25rem 0" }}>
        {overview.items} item{overview.items === 1 ? "" : "s"} in view ·{" "}
        {overview.withMetrics} measured · {formatCount(overview.totalViews)}{" "}
        latest-known views
        {overview.excludedUndated > 0 && windowLabel
          ? ` · ${overview.excludedUndated} undated excluded from the window`
          : ""}
        .
      </p>
      {overview.top.length > 0 ? (
        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <h3>Top performers</h3>
            <ol style={{ paddingLeft: "1.25rem", margin: "0.25rem 0" }}>
              {overview.top.map((t) => (
                <li key={t.id} style={{ marginBottom: "0.35rem" }}>
                  <Link href={`/content/${encodeURIComponent(t.id)}`}>
                    {t.title}
                  </Link>{" "}
                  <span style={{ color: "#6b7280" }}>
                    ({platformLabel(t.platform)}) —{" "}
                    {formatCount(t.latestMetrics?.views ?? null)} views
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <h3>By platform</h3>
            <ul style={{ listStyle: "none", margin: "0.25rem 0", padding: 0 }}>
              {overview.byPlatform.map((p) => (
                <li key={p.platform} style={{ marginBottom: "0.25rem" }}>
                  <Link
                    href={`/content?platform=${encodeURIComponent(p.platform)}`}
                  >
                    {platformLabel(p.platform)}
                  </Link>{" "}
                  — {p.items} item{p.items === 1 ? "" : "s"} ·{" "}
                  {formatCount(p.views)} views
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p style={{ color: "#9ca3af" }}>
          No snapshots yet — add numbers on a piece&apos;s page and the rankings
          fill in.
        </p>
      )}
    </section>
  );
}
