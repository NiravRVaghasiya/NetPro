import { describe, expect, it } from "vitest";
import { ContentError } from "./types";
import {
  detectPlatform,
  isTrackableUrl,
  normalizeContentUrl,
  parsePlatform,
} from "./urls";

describe("normalizeContentUrl", () => {
  it("lower-cases the host and drops default ports", () => {
    expect(normalizeContentUrl("https://EXAMPLE.com:443/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeContentUrl("http://Example.COM:80/a")).toBe(
      "http://example.com/a",
    );
    expect(normalizeContentUrl("https://example.com:8443/a")).toBe(
      "https://example.com:8443/a",
    );
  });

  it("keeps the path case (paths can be case-sensitive) but strips trailing slashes", () => {
    expect(normalizeContentUrl("https://example.com/Posts/Hello/")).toBe(
      "https://example.com/Posts/Hello",
    );
    expect(normalizeContentUrl("https://example.com/")).toBe(
      "https://example.com",
    );
    expect(normalizeContentUrl("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("drops the fragment", () => {
    expect(normalizeContentUrl("https://example.com/p#comments")).toBe(
      "https://example.com/p",
    );
  });

  it("strips tracking params and sorts the survivors", () => {
    expect(
      normalizeContentUrl(
        "https://example.com/p?utm_source=x&b=2&a=1&fbclid=zzz&utm_medium=y",
      ),
    ).toBe("https://example.com/p?a=1&b=2");
    expect(normalizeContentUrl("https://example.com/p?gclid=1&msclkid=2")).toBe(
      "https://example.com/p",
    );
    // Tracking-param matching is case-insensitive; real params keep their case.
    expect(
      normalizeContentUrl("https://example.com/p?UTM_SOURCE=x&Page=2"),
    ).toBe("https://example.com/p?Page=2");
  });

  it("treats the same post shared two ways as one key", () => {
    const a = normalizeContentUrl(
      "https://Example.com/p/?utm_source=twitter#top",
    );
    const b = normalizeContentUrl("http://example.com:80/p");
    expect(a).toBe("https://example.com/p");
    // Scheme is identity: http and https are different deployments, not the same post.
    expect(b).toBe("http://example.com/p");
    expect(a).not.toBe(b);
  });

  it("rejects relative links, non-http schemes and junk", () => {
    for (const bad of [
      "",
      "   ",
      "/relative/path",
      "example.com/no-scheme",
      "javascript:alert(1)",
      "mailto:ada@engines.dev",
      "ftp://example.com/file",
      "https://exa mple.com/",
    ]) {
      expect(() => normalizeContentUrl(bad), bad || "(empty)").toThrow(
        ContentError,
      );
    }
  });

  it("rejects overlong URLs", () => {
    expect(() =>
      normalizeContentUrl(`https://example.com/${"a".repeat(2048)}`),
    ).toThrow(/2048/);
  });
});

describe("isTrackableUrl", () => {
  it("is the cheap http(s) pre-check", () => {
    expect(isTrackableUrl("https://example.com/p")).toBe(true);
    expect(isTrackableUrl("http://example.com")).toBe(true);
    expect(isTrackableUrl(null)).toBe(false);
    expect(isTrackableUrl("")).toBe(false);
    expect(isTrackableUrl("not a url")).toBe(false);
    expect(isTrackableUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("detectPlatform", () => {
  it("maps known hosts, ignoring www and subdomains", () => {
    expect(detectPlatform("https://dev.to/ada/post")).toBe("devto");
    expect(detectPlatform("https://www.x.com/ada/status/1")).toBe("x");
    expect(detectPlatform("https://twitter.com/ada/status/1")).toBe("twitter");
    expect(detectPlatform("https://m.youtube.com/watch?v=1")).toBe("youtube");
    expect(detectPlatform("https://youtu.be/abc")).toBe("youtube");
    expect(detectPlatform("https://github.com/ada/repo")).toBe("github");
    expect(detectPlatform("https://www.linkedin.com/posts/ada_x")).toBe(
      "linkedin",
    );
  });

  it("returns null for blogs and junk (the caller picks the fallback)", () => {
    expect(detectPlatform("https://ada.example.com/essay")).toBe(null);
    expect(detectPlatform("https://notdev.to.evil.com/x")).toBe(null);
    expect(detectPlatform("not a url")).toBe(null);
  });
});

describe("parsePlatform", () => {
  it("accepts the whitelist case-insensitively, keeping x and twitter distinct", () => {
    expect(parsePlatform("Blog")).toBe("blog");
    expect(parsePlatform("x")).toBe("x");
    expect(parsePlatform("Twitter")).toBe("twitter");
    expect(parsePlatform("DEVTO")).toBe("devto");
  });

  it("rejects unknowns with the allowed list", () => {
    expect(() => parsePlatform("tiktok")).toThrow(/blog, twitter, x/);
    expect(() => parsePlatform("")).toThrow(ContentError);
  });
});
