import { describe, expect, it } from "vitest";
import {
  invalidLinkedInUrlMessage,
  linkedinSlugToName,
  parseLinkedInProfileUrl,
  sameLinkedInProfile,
  tryParseLinkedInProfileUrl,
  unsupportedLinkedInUrlMessage,
  LinkedInUrlError,
} from "./linkedin-url";

describe("parseLinkedInProfileUrl", () => {
  it.each([
    "https://www.linkedin.com/in/john-doe",
    "https://www.linkedin.com/in/john-doe/",
    "https://linkedin.com/in/john-doe",
    "http://www.linkedin.com/in/john-doe",
    "linkedin.com/in/john-doe",
    "www.linkedin.com/in/john-doe",
    "  https://www.linkedin.com/in/john-doe  ",
  ])("accepts %s", (input) => {
    const ref = parseLinkedInProfileUrl(input);
    expect(ref.username).toBe("john-doe");
    expect(ref.usernameKey).toBe("john-doe");
    expect(ref.normalizedUrl).toBe("https://www.linkedin.com/in/john-doe");
  });

  it("strips query strings and fragments", () => {
    expect(
      parseLinkedInProfileUrl("https://www.linkedin.com/in/john-doe?trk=public_profile&lipi=abc#section")
        .normalizedUrl,
    ).toBe("https://www.linkedin.com/in/john-doe");
  });

  it("collapses profile sub-pages to the base profile", () => {
    expect(
      parseLinkedInProfileUrl("https://www.linkedin.com/in/john-doe/recent-activity/all/")
        .normalizedUrl,
    ).toBe("https://www.linkedin.com/in/john-doe");
  });

  it("keeps the username's case but keys case-insensitively", () => {
    const ref = parseLinkedInProfileUrl("https://www.linkedin.com/in/John-Doe/");
    expect(ref.username).toBe("John-Doe");
    expect(ref.usernameKey).toBe("john-doe");
    expect(ref.normalizedUrl).toBe("https://www.linkedin.com/in/John-Doe");
  });

  it("accepts other linkedin.com subdomains and normalizes to www", () => {
    expect(parseLinkedInProfileUrl("https://uk.linkedin.com/in/john-doe").normalizedUrl).toBe(
      "https://www.linkedin.com/in/john-doe",
    );
  });

  it.each([
    "https://www.linkedin.com/company/example",
    "https://www.linkedin.com/jobs/",
    "https://www.linkedin.com/school/example",
    "https://www.linkedin.com/posts/ada_x",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/in",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/in//",
    "https://www.linkedin.com/",
  ])("rejects LinkedIn non-profile route %s as unsupported", (input) => {
    const result = tryParseLinkedInProfileUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_route");
      expect(result.message).toBe(unsupportedLinkedInUrlMessage());
    }
  });

  it.each([
    "https://example.com/in/john-doe",
    "https://fakelinkedin.com/in/john-doe",
    "https://linkedin.com.evil.com/in/john-doe",
    "https://wwwlinkedin.com/in/john-doe",
  ])("rejects non-LinkedIn domain %s", (input) => {
    const result = tryParseLinkedInProfileUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_linkedin");
      expect(result.message).toBe(invalidLinkedInUrlMessage());
    }
  });

  it.each([
    "not-a-url",
    "::::",
    "javascript:alert(1)",
    "mailto:jane@example.com",
    "ftp://linkedin.com/in/john-doe",
    "https://user:pass@www.linkedin.com/in/john-doe",
    "https://www.linkedin.com:8443/in/john-doe",
    "https://www.linkedin.com/in/john doe",
  ])("rejects malformed input %s", (input) => {
    const result = tryParseLinkedInProfileUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_url");
      expect(result.message).toBe(invalidLinkedInUrlMessage());
    }
  });

  it("rejects empty input with its own message", () => {
    const result = tryParseLinkedInProfileUrl("   ");
    expect(result).toEqual({
      ok: false,
      code: "empty",
      message: "Paste a LinkedIn profile URL to continue.",
    });
  });

  it("rejects absurdly long input", () => {
    const result = tryParseLinkedInProfileUrl(
      `https://www.linkedin.com/in/${"a".repeat(3000)}`,
    );
    expect(result.ok).toBe(false);
  });

  it("throws LinkedInUrlError (not a generic error) for API mapping", () => {
    expect(() => parseLinkedInProfileUrl("nope")).toThrow(LinkedInUrlError);
  });
});

describe("sameLinkedInProfile", () => {
  it("matches across scheme/host/case/query differences", () => {
    expect(
      sameLinkedInProfile(
        "https://linkedin.com/in/john-doe",
        "https://www.linkedin.com/in/John-Doe/?trk=x#y",
      ),
    ).toBe(true);
  });

  it("distinguishes different slugs", () => {
    expect(
      sameLinkedInProfile(
        "https://www.linkedin.com/in/john-doe",
        "https://www.linkedin.com/in/jane-doe",
      ),
    ).toBe(false);
  });

  it("never matches unparseable inputs", () => {
    expect(sameLinkedInProfile("https://www.linkedin.com/company/x", "https://www.linkedin.com/company/x")).toBe(
      false,
    );
    expect(sameLinkedInProfile("not-a-url", "not-a-url")).toBe(false);
  });
});

describe("linkedinSlugToName", () => {
  it.each([
    ["john-doe", "John Doe"],
    ["jane", "Jane"],
    ["mary_jane-watson", "Mary Jane Watson"],
    ["ada-lovelace-4b5a6c7d", "Ada Lovelace"],
    ["john-smith-123456", "John Smith"],
    ["li-wei", "LI Wei"],
  ])("humanizes %s as %s", (slug, expected) => {
    expect(linkedinSlugToName(slug)).toBe(expected);
  });
});
