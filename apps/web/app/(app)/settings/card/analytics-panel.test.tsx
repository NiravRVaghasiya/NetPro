import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardViewsAnalytics } from "./analytics-panel";
import type { ViewsOverview } from "@netpro/core/src/views";

function overviewWith(views: number): ViewsOverview {
  return {
    stats: {
      window: { days: 30, since: "2026-08-09T12:00:00.000Z", until: "2026-09-08T12:00:00.000Z" },
      totals: { views, uniqueViewers: views, resolvedContacts: 0, avgDurationMs: null },
      excluded: { bots: 0, ownerViews: 2 },
      filters: { includeBots: false, includeOwnerViews: false },
      series: [{ date: "2026-09-08", views, unique: views }],
      byReferrer: views > 0 ? [{ value: "(direct)", count: views, share: 1 }] : [],
      byCountry: [],
      byPage: views > 0 ? [{ value: "/card", count: views, share: 1 }] : [],
    },
    recent: {
      views:
        views > 0
          ? [
              {
                id: "w1",
                viewedAt: "2026-09-08T10:00:00.000Z",
                viewedPage: "/card",
                referrer: null,
                country: null,
                city: null,
                durationMs: null,
                isBot: false,
                isOwnerView: false,
                resolvedContact: null,
              },
            ]
          : [],
      total: views,
      limit: 10,
      offset: 0,
    },
    matches: { matches: [], total: 0 },
  };
}

function render(overview: ViewsOverview, days = 30, includeBots = false): string {
  return renderToStaticMarkup(
    <CardViewsAnalytics overview={overview} days={days} includeBots={includeBots} />,
  );
}

describe("CardViewsAnalytics (v2.5 phase 3)", () => {
  it("renders the current window as active and preserves the bots flag in range links", () => {
    const html = render(overviewWith(5), 7, true);
    expect(html).toContain('aria-current="page"');
    // Range links keep bots=1; the toggle offers to hide them again.
    expect(html).toContain("/settings/card?days=30&amp;bots=1");
    expect(html).toContain("/settings/card?days=7\">hide bots</a>");
  });

  it("renders unattributed views as anonymous with direct traffic", () => {
    const html = render(overviewWith(1));
    expect(html).toContain("anonymous");
    expect(html).toContain("direct");
    expect(html).not.toContain("/contacts/");
  });

  it("reports held-back owner views alongside real counts", () => {
    const html = render(overviewWith(4));
    expect(html).toContain("2 owner views");
    expect(html).toContain("excluded from these counts");
  });

  it("names the held-back rows in the empty state instead of hiding them", () => {
    const html = render(overviewWith(0));
    expect(html).toContain("No views in the last 30 days yet");
    expect(html).toContain("2 owner views held");
    expect(html).not.toContain("Views per day");
  });

  it("tolerates empty breakdowns without empty tables", () => {
    const html = render(overviewWith(1));
    expect(html).toContain("No country data yet.");
  });
});
