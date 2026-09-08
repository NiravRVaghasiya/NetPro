// apps/web/app/(app)/settings/card/analytics-panel.tsx — v2.5 Phase 3: the
// owner-only "who viewed your profile" surface. Server-rendered and dumb by
// design (the page resolves the window and fetches the overview) so it
// renders in unit tests from a hand-built overview. Tables, not a chart
// library, per the plan — the dashboard carries the sparkline.
import Link from "next/link";
import type { ViewsOverview } from "@netpro/core/src/views";

function hostOf(referrer: string | null): string {
  if (!referrer) return "direct";
  try {
    return new URL(referrer).host.toLowerCase() || referrer;
  } catch {
    return referrer;
  }
}

function rangeHref(days: number, includeBots: boolean): string {
  const p = new URLSearchParams({ days: String(days) });
  if (includeBots) p.set("bots", "1");
  return `/settings/card?${p.toString()}`;
}

function botsHref(days: number, includeBots: boolean): string {
  const p = new URLSearchParams({ days: String(days) });
  if (!includeBots) p.set("bots", "1");
  return `/settings/card?${p.toString()}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const TH = "border-b border-[#dce3dc] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[#627366]";
const TD = "border-b border-[#edf0ea] px-3 py-2 text-sm text-[#31413a]";

export function CardViewsAnalytics({
  overview,
  days,
  includeBots,
}: {
  overview: ViewsOverview;
  days: number;
  includeBots: boolean;
}) {
  const { stats, recent, matches } = overview;
  const t = stats.totals;
  return (
    <section className="space-y-4 rounded-xl border border-[#dce3dc] bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#183c30]">View analytics</h2>
        <nav className="flex items-center gap-2 text-sm" aria-label="Analytics window">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={rangeHref(d, includeBots)}
              aria-current={d === days ? "page" : undefined}
              className={
                d === days
                  ? "rounded-full bg-[#183c30] px-2.5 py-0.5 font-medium text-white"
                  : "rounded-full bg-[#eef2ec] px-2.5 py-0.5 text-[#31413a] hover:bg-[#e2eae0]"
              }
            >
              {d}d
            </Link>
          ))}
          <Link
            href={botsHref(days, includeBots)}
            className="rounded-full bg-[#eef2ec] px-2.5 py-0.5 text-[#31413a] hover:bg-[#e2eae0]"
          >
            {includeBots ? "hide bots" : "show bots"}
          </Link>
        </nav>
      </div>

      {t.views === 0 ? (
        <p className="text-sm leading-6 text-[#44534a]">
          No views in the last {days} days yet
          {stats.excluded.bots > 0 || stats.excluded.ownerViews > 0 ? (
            <>
              {" "}
              from real visitors (
              {[
                stats.excluded.bots > 0 ? `${stats.excluded.bots} bot` : null,
                stats.excluded.ownerViews > 0 ? `${stats.excluded.ownerViews} owner` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {stats.excluded.bots + stats.excluded.ownerViews === 1 ? " view" : " views"} held
              back)
            </>
          ) : null}
          . Share your card link — views appear here.
        </p>
      ) : (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Views", String(t.views)],
              ["Unique viewers", String(t.uniqueViewers)],
              ["Known visitors", String(matches.total)],
              ["Avg read", formatDuration(t.avgDurationMs)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-[#dce3dc] bg-[#f4f6f0] px-3 py-2">
                <dt className="text-xs text-[#627366]">{label}</dt>
                <dd className="text-xl font-semibold text-[#183c30]">{value}</dd>
              </div>
            ))}
          </dl>
          {(stats.excluded.bots > 0 || stats.excluded.ownerViews > 0) && (
            <p className="text-xs text-[#627366]">
              {[
                stats.excluded.bots > 0 ? `${stats.excluded.bots} bot view${stats.excluded.bots === 1 ? "" : "s"}` : null,
                stats.excluded.ownerViews > 0
                  ? `${stats.excluded.ownerViews} owner view${stats.excluded.ownerViews === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              excluded from these counts.
            </p>
          )}

          <div>
            <h3 className="mb-2 font-semibold text-[#183c30]">Views per day</h3>
            <div className="overflow-x-auto rounded-lg border border-[#dce3dc]">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>Date</th>
                    <th className={TH}>Views</th>
                    <th className={TH}>Unique</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats.series].reverse().map((p) => (
                    <tr key={p.date}>
                      <td className={TD}>{p.date}</td>
                      <td className={TD}>{p.views}</td>
                      <td className={TD}>{p.unique}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 font-semibold text-[#183c30]">Top referrers</h3>
              {stats.byReferrer.length === 0 ? (
                <p className="text-sm text-[#627366]">No referrer data yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-[#dce3dc]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Site</th>
                        <th className={TH}>Views</th>
                        <th className={TH}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byReferrer.map((r) => (
                        <tr key={r.value}>
                          <td className={TD}>{r.value}</td>
                          <td className={TD}>{r.count}</td>
                          <td className={TD}>{Math.round(r.share * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 font-semibold text-[#183c30]">Top countries</h3>
              {stats.byCountry.length === 0 ? (
                <p className="text-sm text-[#627366]">No country data yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-[#dce3dc]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Country</th>
                        <th className={TH}>Views</th>
                        <th className={TH}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byCountry.map((r) => (
                        <tr key={r.value}>
                          <td className={TD}>{r.value}</td>
                          <td className={TD}>{r.count}</td>
                          <td className={TD}>{Math.round(r.share * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="mb-2 font-semibold text-[#183c30]">
              Recent views{" "}
              <span className="font-normal text-[#627366]">
                (showing {recent.views.length} of {recent.total})
              </span>
            </h3>
            {recent.views.length === 0 ? (
              <p className="text-sm text-[#627366]">None in this window.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-[#dce3dc]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Page</th>
                      <th className={TH}>Via</th>
                      <th className={TH}>Visitor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.views.map((v) => (
                      <tr key={v.id}>
                        <td className={TD}>{v.viewedAt.slice(0, 16).replace("T", " ")}</td>
                        <td className={TD}>{v.viewedPage}</td>
                        <td className={TD}>{hostOf(v.referrer)}</td>
                        <td className={TD}>
                          {v.resolvedContact ? (
                            <Link
                              href={`/contacts/${v.resolvedContact.id}`}
                              className="text-[#2c5e43] underline"
                            >
                              {v.resolvedContact.fullName}
                            </Link>
                          ) : (
                            <span className="text-[#627366]">anonymous</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {matches.matches.length > 0 && (
            <div>
              <h3 className="mb-2 font-semibold text-[#183c30]">
                Known visitors{" "}
                <span className="font-normal text-[#627366]">({matches.total})</span>
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[#31413a]">
                {matches.matches.map((m) => (
                  <li key={m.viewId}>
                    <Link href={`/contacts/${m.contact.id}`} className="text-[#2c5e43] underline">
                      {m.contact.fullName}
                    </Link>{" "}
                    <span className="text-[#627366]">
                      — {m.viewedAt.slice(0, 10)} via {hostOf(m.referrer)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
