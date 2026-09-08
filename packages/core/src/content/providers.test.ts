import { describe, expect, it } from "vitest";
import {
  CONTENT_PROVIDERS,
  DEVTO_PROVIDER,
  GITHUB_PROVIDER,
  MANUAL_PROVIDER,
  RSS_PROVIDER,
  TWITTER_PROVIDER,
  canFetchMetrics,
  resolveContentProviders,
  resolveMetricsProvider,
} from "./providers";

describe("content providers", () => {
  it("ships manual + rss enabled and the API providers disabled", () => {
    expect(MANUAL_PROVIDER.enabled).toBe(true);
    expect(RSS_PROVIDER.enabled).toBe(true);
    expect(DEVTO_PROVIDER.enabled).toBe(false);
    expect(TWITTER_PROVIDER.enabled).toBe(false);
    expect(GITHUB_PROVIDER.enabled).toBe(false);
    expect(CONTENT_PROVIDERS.map((p) => p.id)).toEqual([
      "devto",
      "twitter",
      "github",
      "rss",
      "manual",
    ]);
  });

  it("routes URLs most-specific-first with manual as the eternal fallback", () => {
    expect(
      resolveContentProviders("https://dev.to/ada/post").map((p) => p.id),
    ).toEqual(["devto", "manual"]);
    expect(
      resolveContentProviders("https://x.com/ada/status/1").map((p) => p.id),
    ).toEqual(["twitter", "manual"]);
    expect(
      resolveContentProviders("https://example.com/feed.xml").map((p) => p.id),
    ).toEqual(["rss", "manual"]);
    expect(
      resolveContentProviders("https://example.com/blog").map((p) => p.id),
    ).toEqual(["manual"]);
    // A provider that throws on canFetch is skipped, not fatal.
    expect(
      resolveContentProviders("https://example.com/x", [
        {
          id: "boom",
          name: "boom",
          enabled: true,
          canFetch: () => {
            throw new Error("nope");
          },
        },
        MANUAL_PROVIDER,
      ]).map((p) => p.id),
    ).toEqual(["manual"]);
  });

  it("recognizes feed-shaped URLs without false positives", () => {
    for (const feed of [
      "https://example.com/feed",
      "https://example.com/feed/",
      "https://example.com/rss.xml",
      "https://example.com/atom.xml",
      "https://example.com/blog?format=xml",
    ]) {
      expect(RSS_PROVIDER.canFetch(feed), feed).toBe(true);
    }
    for (const page of [
      "https://example.com/feedback",
      "https://example.com/blog/feed-me-seymour",
      "https://example.com/post",
      "not a url",
    ]) {
      expect(RSS_PROVIDER.canFetch(page), page).toBe(false);
    }
  });

  it("reports metrics capability honestly: nothing enabled can fetch today", () => {
    expect(canFetchMetrics(MANUAL_PROVIDER)).toBe(false);
    expect(canFetchMetrics(RSS_PROVIDER)).toBe(false);
    expect(canFetchMetrics(DEVTO_PROVIDER)).toBe(false);
    expect(resolveMetricsProvider("https://dev.to/ada/post")).toBe(null);
    expect(resolveMetricsProvider("https://example.com/post")).toBe(null);
  });

  it("lets a future provider plug in without touching the module", () => {
    const fake = {
      id: "fake",
      name: "Fake",
      enabled: true,
      canFetch: (url: string) => url.includes("fake.example"),
      fetchMetrics: async () => ({ views: 42 }),
    };
    expect(canFetchMetrics(fake)).toBe(true);
    expect(
      resolveMetricsProvider("https://fake.example/p", [
        ...CONTENT_PROVIDERS,
        fake,
      ])?.id,
    ).toBe("fake");
  });

  it("disabled stubs throw not_configured naming the key, never a 500-shaped error", async () => {
    await expect(
      DEVTO_PROVIDER.fetchMetrics!("https://dev.to/ada/post"),
    ).rejects.toMatchObject({
      name: "ContentError",
      code: "not_configured",
      message: expect.stringContaining("DEVTO_API_KEY"),
    });
    await expect(
      TWITTER_PROVIDER.fetchMetrics!("https://x.com/ada/status/1"),
    ).rejects.toMatchObject({
      code: "not_configured",
      message: expect.stringContaining("TWITTER_BEARER_TOKEN"),
    });
    await expect(
      GITHUB_PROVIDER.fetchMetrics!("https://github.com/ada/repo"),
    ).rejects.toMatchObject({
      code: "not_configured",
      message: expect.stringContaining("GITHUB_TOKEN"),
    });
  });

  it("the rss provider parses feed bodies", () => {
    const parsed = RSS_PROVIDER.parse!(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>A</title><link>https://example.com/a</link></item></channel></rss>`,
    );
    expect(parsed.rows.map((r) => r.title)).toEqual(["A"]);
  });
});
