import Link from "next/link";
import { conn } from "@/lib/db";
import {
  getNetworkOverview,
  type NetworkGraph,
  type NetworkOverview,
} from "@netpro/core/src/analytics";
import type { ViewsOverview } from "@netpro/core/src/views";
import { listFollowUps } from "@netpro/core/src/crm";

// ─── small presentational helpers (pure, no client JS) ──────────────────────

const CARD = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "0.75rem 1rem",
  minWidth: 130,
};

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div style={CARD}>
      <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{value}</div>
      {hint ? (
        <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{hint}</div>
      ) : null}
    </div>
  );
}

function ValueBars({ values, total }: { values: NetworkOverview["topCompanies"]; total: number }) {
  if (values.length === 0) {
    return <p style={{ color: "#9ca3af" }}>No data yet.</p>;
  }
  const max = Math.max(...values.map((v) => v.count), 1);
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {values.map((v) => (
        <li key={v.value} style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
            <span>{v.value}</span>
            <span style={{ color: "#6b7280" }}>
              {v.count} ({Math.round((total > 0 ? v.count / total : 0) * 100)}%)
            </span>
          </div>
          <div style={{ background: "#f3f4f6", borderRadius: 4, height: 8 }}>
            <div
              style={{
                background: "#3b82f6",
                borderRadius: 4,
                height: 8,
                width: `${(v.count / max) * 100}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** v2.0 Phase 2 — graph-native analytics strip (communities/centrality/paths). */
function NetworkGraphSection({ graph }: { graph: NetworkGraph | undefined }) {
  if (!graph) return null;
  if (graph.degraded) {
    return (
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Network graph</h2>
        <p style={{ color: "#b45309" }}>{graph.degraded.reason}</p>
      </section>
    );
  }
  if (graph.nodes === 0) {
    return (
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Network graph</h2>
        <p style={{ color: "#9ca3af" }}>
          No confirmed edges yet. Import a LinkedIn CSV (mutuals arrive as candidates) or{" "}
          <Link href="/edges">add links yourself</Link>
          {graph.pendingCandidates > 0 ? (
            <>
              {" · "}
              <Link href="/edges?status=pending">
                {graph.pendingCandidates} pending candidate{graph.pendingCandidates === 1 ? "" : "s"} to review
              </Link>
            </>
          ) : null}
          .
        </p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2>Network graph</h2>
      <p style={{ color: "#6b7280", margin: "0.25rem 0" }}>
        {graph.nodes} of {graph.totalContacts} contacts linked by {graph.edges} confirmed edge
        {graph.edges === 1 ? "" : "s"} · {graph.components.count} component
        {graph.components.count === 1 ? "" : "s"} (largest {graph.components.largestSize})
        {graph.avgPathLength.value !== null ? ` · avg path length ${graph.avgPathLength.value}` : ""}
        {" · "}
        <Link href="/edges">manage edges</Link>
      </p>
      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <h3>Communities ({graph.communities.count}, modularity {graph.communities.modularity})</h3>
          <ul>
            {graph.communities.top.map((c) => (
              <li key={c.communityId}>
                <strong>{c.label}</strong> — {c.size} member{c.size === 1 ? "" : "s"} (
                {Math.round(c.share * 100)}%){" "}
                <span style={{ color: "#6b7280" }}>
                  {c.members.map((m) => m.fullName).join(", ")}
                  {c.truncated ? "…" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <h3>Most connected</h3>
          <ul>
            {graph.centrality.top.map((t) => (
              <li key={t.contactId}>
                <Link href={`/contacts/${t.contactId}`}>{t.fullName}</Link> — {t.degree} edge
                {t.degree === 1 ? "" : "s"}
                {t.betweenness !== null ? (
                  <span style={{ color: "#6b7280" }}> · betweenness {t.betweenness}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {!graph.centrality.betweennessComputed && graph.centrality.skippedReason ? (
            <p style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{graph.centrality.skippedReason}</p>
          ) : null}
        </div>
      </div>
      {graph.warmIntros.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          <h3>Warm-intro candidates</h3>
          <ul>
            {graph.warmIntros.map((w) => (
              <li key={`${w.contactId}-${w.targetId}`}>
                <Link href={`/contacts/${w.contactId}`}>{w.contactName}</Link> →{" "}
                <Link href={`/contacts/${w.targetId}`}>{w.targetName}</Link>{" "}
                <span style={{ color: "#6b7280" }}>
                  via{" "}
                  <Link href={`/contacts/${w.viaId}`}>{w.viaName}</Link> ({w.hops} hops)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {graph.pendingCandidates > 0 ? (
        <p style={{ color: "#92400e", fontSize: "0.875rem" }}>
          <Link href="/edges?status=pending">
            {graph.pendingCandidates} pending edge candidate
            {graph.pendingCandidates === 1 ? "" : "s"}
          </Link>{" "}
          are excluded from the analysis until you confirm them.
        </p>
      ) : null}
    </section>
  );
}

/** Server-rendered SVG bar chart — no chart library, no client JS. */
function GrowthChart({ overview }: { overview: NetworkOverview }) {
  const series = overview.growth.series;
  if (series.length === 0) return null;

  const width = 640;
  const height = 170;
  const padLeft = 8;
  const padBottom = 22;
  const padTop = 16;
  const max = Math.max(...series.map((p) => p.count), 1);
  const slot = (width - padLeft * 2) / series.length;
  const barWidth = Math.min(36, slot * 0.6);
  const chartHeight = height - padBottom - padTop;

  const shortMonth = (m: string) => {
    const [y, mm] = m.split("-");
    const d = new Date(Date.UTC(Number(y), Number(mm) - 1, 1));
    return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`New connections per month, last ${series.length} months`}
      style={{ width: "100%", height: "auto" }}
    >
      {series.map((p, i) => {
        const h = (p.count / max) * chartHeight;
        const x = padLeft + i * slot + (slot - barWidth) / 2;
        const y = padTop + chartHeight - h;
        return (
          <g key={p.month}>
            {p.count > 0 ? (
              <text
                x={x + barWidth / 2}
                y={y - 4}
                textAnchor="middle"
                fontSize={10}
                fill="#374151"
              >
                {p.count}
              </text>
            ) : null}
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(h, p.count > 0 ? 2 : 0)}
              rx={2}
              fill="#3b82f6"
            />
            <text
              x={x + barWidth / 2}
              y={height - 8}
              textAnchor="middle"
              fontSize={10}
              fill="#6b7280"
            >
              {shortMonth(p.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** v2.5 Phase 3 — compact daily-views sparkline, server-rendered SVG like GrowthChart. */
function ViewsSparkline({ views }: { views: ViewsOverview }) {
  const series = views.stats.series;
  const max = Math.max(...series.map((p) => p.views), 1);
  const width = 320;
  const height = 48;
  const slot = width / series.length;
  const barWidth = Math.max(2, Math.min(10, slot * 0.7));
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Profile views per day, last ${series.length} days`}
      style={{ width: "100%", maxWidth: 320, height: "auto", display: "block" }}
    >
      {series.map((p, i) => {
        const h = Math.max(p.views > 0 ? 3 : 0, (p.views / max) * (height - 4));
        const x = i * slot + (slot - barWidth) / 2;
        return (
          <rect
            key={p.date}
            x={x}
            y={height - h}
            width={barWidth}
            height={h}
            rx={1}
            fill="#10b981"
          >
            <title>{`${p.date}: ${p.views} views`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** v2.5 Phase 3 — "Profile views" strip: totals, sparkline, referrers, recent. */
function ProfileViewsSection({ views }: { views: ViewsOverview | undefined }) {
  if (!views) return null;
  const { stats, recent, matches } = views;
  if (stats.totals.views === 0) {
    return (
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Profile views</h2>
        <p style={{ color: "#9ca3af" }}>
          No views in the last {stats.window.days} days yet.{" "}
          <Link href="/settings/card">Publish your card</Link> and share the
          link — views appear here.
        </p>
      </section>
    );
  }

  const known =
    matches.total === 0
      ? "no known visitors yet"
      : `${matches.total} known-visitor view${matches.total === 1 ? "" : "s"}`;
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2>Profile views</h2>
      <p style={{ color: "#6b7280", margin: "0.25rem 0" }}>
        {stats.totals.views} view{stats.totals.views === 1 ? "" : "s"} ·{" "}
        {stats.totals.uniqueViewers} unique viewer
        {stats.totals.uniqueViewers === 1 ? "" : "s"} · {known} (last{" "}
        {stats.window.days} days) · <Link href="/settings/card">all analytics</Link>
      </p>
      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <ViewsSparkline views={views} />
          {stats.byReferrer.length > 0 ? (
            <>
              <h3>Top referrers</h3>
              <ul>
                {stats.byReferrer.map((r) => (
                  <li key={r.value}>
                    {r.value} — {r.count} ({Math.round(r.share * 100)}%)
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <h3>Recent views</h3>
          {recent.views.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>None in this window.</p>
          ) : (
            <ul>
              {recent.views.map((v) => (
                <li key={v.id}>
                  {v.viewedAt.slice(0, 10)} · {v.viewedPage} ·{" "}
                  {v.resolvedContact ? (
                    <Link href={`/contacts/${v.resolvedContact.id}`}>
                      {v.resolvedContact.fullName}
                    </Link>
                  ) : (
                    <span style={{ color: "#6b7280" }}>anonymous</span>
                  )}
                  {v.country ? ` · ${v.country}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  // limit 1: only the pending counts are consumed, for the follow-up card.
  const [overview, followUps] = await Promise.all([
    getNetworkOverview(conn),
    listFollowUps(conn, { view: "pending", limit: 1 }),
  ]);
  const m = overview.metrics;
  const g = overview.growth;
  const due = followUps.counts.overdue + followUps.counts.dueToday;

  if (m.totalContacts === 0) {
    return (
      <div>
        <h1>Dashboard</h1>
        <p>
          No contacts yet.{" "}
          <Link href="/import">Import your connections</Link> to see network
          analytics here.
        </p>
      </div>
    );
  }

  const rate =
    g.ratePct === null
      ? "–"
      : `${g.ratePct > 0 ? "+" : ""}${g.ratePct}% vs prior 30d`;

  return (
    <div>
      <h1>Dashboard</h1>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <MetricCard label="Network score" value={`${overview.score.score}/100`} />
        <MetricCard label="Contacts" value={String(m.totalContacts)} />
        <MetricCard
          label="Active (30d)"
          value={String(m.activeConnections)}
          hint={`${Math.round(m.activeRate * 100)}% of network`}
        />
        <MetricCard
          label="Dormant (90d+)"
          value={String(m.dormantConnections)}
          hint={`${Math.round(m.dormantRate * 100)}% of network`}
        />
        <MetricCard label="Growth (30d)" value={`+${g.last30}`} hint={rate} />
        <MetricCard
          label="Diversity"
          value={String(m.diversityEffective)}
          hint={`effective ${m.diversityField}s`}
        />
        <Link href="/contacts" style={{ textDecoration: "none", color: "inherit" }}>
          <MetricCard
            label="Follow-ups due"
            value={String(due)}
            hint={`${followUps.counts.overdue} overdue · ${followUps.counts.dueToday} today`}
          />
        </Link>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Growth</h2>
        <p style={{ color: "#6b7280", margin: "0.25rem 0" }}>
          New connections per month — {g.series[0]?.month} through{" "}
          {g.series[g.series.length - 1]?.month}, {m.totalContacts} total.
        </p>
        <GrowthChart overview={overview} />
      </section>

      <section
        style={{
          marginTop: "1.5rem",
          display: "flex",
          gap: "2rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 260px" }}>
          <h2>Top companies</h2>
          <ValueBars values={overview.topCompanies} total={m.totalContacts} />
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <h2>Top industries</h2>
          <ValueBars values={overview.topIndustries} total={m.totalContacts} />
        </div>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Clusters</h2>
        {overview.clusters.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>
            No company data yet — run enrichment to fill it in.
          </p>
        ) : (
          <ul>
            {overview.clusters.map((c) => (
              <li key={c.key}>
                <strong>{c.label}</strong> — {c.size} contact
                {c.size === 1 ? "" : "s"} ({Math.round(c.share * 100)}%)
                {c.topRoles.length > 0 ? (
                  <span style={{ color: "#6b7280" }}>
                    {" "}
                    · {c.topRoles.map((r) => r.value).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <NetworkGraphSection graph={overview.graph} />

      <ProfileViewsSection views={overview.views} />

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Dormant ties</h2>
        <p style={{ color: "#6b7280", margin: "0.25rem 0" }}>
          No known interaction in 90+ days — your reconnect list.
        </p>
        {overview.dormant.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>
            None — every known touchpoint is inside the window.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Role</th>
                <th>Last touch</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {overview.dormant.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/contacts/${d.id}`}>{d.fullName}</Link>
                  </td>
                  <td>{d.company ?? "–"}</td>
                  <td>{d.role ?? "–"}</td>
                  <td>{d.daysSince}d ago</td>
                  <td>
                    {d.relationshipScore !== null
                      ? d.relationshipScore.toFixed(2)
                      : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
