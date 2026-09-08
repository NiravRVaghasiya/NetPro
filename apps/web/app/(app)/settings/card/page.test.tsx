import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ conn: {} }));
vi.mock("@netpro/core/src/card/repository", () => ({
  getProfileCardState: vi.fn(),
}));
vi.mock("@netpro/core/src/views", async (importOriginal) => {
  // Only the overview fetch is canned; the tracking panel still needs the
  // real beacon helpers (rate limiter, hashing) from this module.
  const actual = await importOriginal<typeof import("@netpro/core/src/views")>();
  return { ...actual, getViewsOverview: vi.fn() };
});
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("LOGIN_REDIRECT");
  },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        host: "netpro.example",
        "x-forwarded-proto": "https",
      }),
  ),
}));
import { auth } from "@/lib/auth";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import { getViewsOverview } from "@netpro/core/src/views";
import CardSettingsPage from "./page";

const editorState = {
  draft: null,
  published: null,
  publishedAt: null,
  updatedAt: null,
};

const emptyOverview = {
  stats: {
    window: { days: 30, since: "2026-08-09T12:00:00.000Z", until: "2026-09-08T12:00:00.000Z" },
    totals: { views: 0, uniqueViewers: 0, resolvedContacts: 0, avgDurationMs: null },
    excluded: { bots: 0, ownerViews: 0 },
    filters: { includeBots: false, includeOwnerViews: false },
    series: [],
    byReferrer: [],
    byCountry: [],
    byPage: [],
  },
  recent: { views: [], total: 0, limit: 10, offset: 0 },
  matches: { matches: [], total: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
  vi.mocked(getProfileCardState).mockResolvedValue(editorState as never);
  vi.mocked(getViewsOverview).mockResolvedValue(emptyOverview as never);
  delete process.env.NETPRO_DISABLE_VIEWS;
});

describe("private card page authorization", () => {
  it("checks auth before reading a draft, independent of layout/middleware", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(CardSettingsPage()).rejects.toThrow("LOGIN_REDIRECT");
    expect(getProfileCardState).not.toHaveBeenCalled();
  });

  it("loads the editor state for the authenticated owner", async () => {
    expect(await CardSettingsPage()).toBeDefined();
    expect(getProfileCardState).toHaveBeenCalledOnce();
  });
});

describe("profile view tracking panel (v2.5 phase 2)", () => {
  it("documents what is and is not stored, with a copy-paste embed snippet", async () => {
    const html = renderToStaticMarkup(await CardSettingsPage());
    expect(html).toContain("Profile view tracking");
    expect(html).toContain("Enabled");
    // The snippet is built from the instance's public origin.
    expect(html).toContain(
      "https://netpro.example/api/card/pixel.gif?p=blog",
    );
    expect(html).toContain("Never stored");
    expect(html).toContain("raw IP addresses");
    expect(html).toContain("90 days");
  });

  it("shows the disabled state when NETPRO_DISABLE_VIEWS is set", async () => {
    process.env.NETPRO_DISABLE_VIEWS = "true";
    try {
      const html = renderToStaticMarkup(await CardSettingsPage());
      expect(html).toContain("Disabled (NETPRO_DISABLE_VIEWS)");
      expect(html).not.toContain(">Enabled<");
    } finally {
      delete process.env.NETPRO_DISABLE_VIEWS;
    }
  });
});

describe("view analytics section (v2.5 phase 3)", () => {
  const fullOverview = {
    stats: {
      window: { days: 7, since: "2026-09-01T12:00:00.000Z", until: "2026-09-08T12:00:00.000Z" },
      totals: { views: 3, uniqueViewers: 2, resolvedContacts: 1, avgDurationMs: 45000 },
      excluded: { bots: 1, ownerViews: 0 },
      filters: { includeBots: false, includeOwnerViews: false },
      series: [
        { date: "2026-09-07", views: 1, unique: 1 },
        { date: "2026-09-08", views: 2, unique: 1 },
      ],
      byReferrer: [{ value: "blog.example", count: 2, share: 2 / 3 }],
      byCountry: [{ value: "GB", count: 2, share: 2 / 3 }],
      byPage: [{ value: "/card", count: 3, share: 1 }],
    },
    recent: {
      views: [
        {
          id: "w1",
          viewedAt: "2026-09-08T10:00:00.000Z",
          viewedPage: "/card",
          referrer: "https://blog.example/hello",
          country: "GB",
          city: null,
          durationMs: 45000,
          isBot: false,
          isOwnerView: false,
          resolvedContact: { id: "ada", fullName: "Ada Lovelace", company: null, role: null },
        },
      ],
      total: 3,
      limit: 10,
      offset: 0,
    },
    matches: {
      matches: [
        {
          viewId: "w1",
          viewedAt: "2026-09-08T10:00:00.000Z",
          viewedPage: "/card",
          referrer: "https://blog.example/hello",
          contact: { id: "ada", fullName: "Ada Lovelace", company: null, role: null },
        },
      ],
      total: 1,
    },
  };

  it("renders stats, breakdowns, and the timeline with contact links", async () => {
    vi.mocked(getViewsOverview).mockResolvedValue(fullOverview as never);
    const html = renderToStaticMarkup(await CardSettingsPage());
    expect(html).toContain("View analytics");
    expect(html).toContain("Views per day");
    expect(html).toContain("2026-09-08");
    expect(html).toContain("Top referrers");
    expect(html).toContain("blog.example");
    expect(html).toContain("Top countries");
    expect(html).toContain("Recent views");
    expect(html).toContain("/contacts/ada");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Known visitors");
    expect(html).toContain("1 bot view");
    expect(html).toContain("show bots");
  });

  it("shows the empty state until the card gets views", async () => {
    const html = renderToStaticMarkup(await CardSettingsPage());
    expect(html).toContain("View analytics");
    expect(html).toContain("No views in the last 30 days yet");
  });

  it("forwards ?days= and ?bots= to the overview, clamping to the retention bound", async () => {
    await CardSettingsPage({ searchParams: Promise.resolve({ days: "7", bots: "1" }) });
    expect(getViewsOverview).toHaveBeenCalledWith(expect.anything(), {
      days: 7,
      limit: 10,
      includeBots: true,
    });
    await CardSettingsPage({ searchParams: Promise.resolve({ days: "365" }) });
    expect(getViewsOverview).toHaveBeenCalledWith(expect.anything(), {
      days: 90,
      limit: 10,
      includeBots: false,
    });
    await CardSettingsPage({ searchParams: Promise.resolve({ days: "soon" }) });
    expect(getViewsOverview).toHaveBeenCalledWith(expect.anything(), {
      days: 30,
      limit: 10,
      includeBots: false,
    });
  });

  it("fetches the editor state and the analytics together, after the auth check", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(CardSettingsPage()).rejects.toThrow("LOGIN_REDIRECT");
    expect(getProfileCardState).not.toHaveBeenCalled();
    expect(getViewsOverview).not.toHaveBeenCalled();
  });
});
