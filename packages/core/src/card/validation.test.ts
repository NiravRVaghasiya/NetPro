import { describe, expect, it } from "vitest";
import { MAX_PROFILE_BYTES, ProfileValidationError } from "./types";
import { parseProfileCardJson, validateProfileCard } from "./validation";

describe("validateProfileCard", () => {
  it("normalizes only explicitly authored public fields", () => {
    expect(validateProfileCard({ fullName: "  Ada Lovelace  " })).toEqual({
      fullName: "Ada Lovelace",
      headline: "",
      bio: "",
      company: "",
      role: "",
      location: "",
      email: "",
      phone: "",
      links: [],
    });
  });

  it("normalizes optional fields, multiline biography, and URLs", () => {
    const result = validateProfileCard({
      fullName: "  李  明  ",
      bio: " First line\r\nSecond line ",
      email: " me+work@example.com ",
      phone: "+44 (20) 1234-5678",
      links: [{ label: " Work ", url: " https://EXAMPLE.com/hello " }],
    });
    expect(result.bio).toBe("First line\nSecond line");
    expect(result.email).toBe("me+work@example.com");
    expect(result.links).toEqual([
      { label: "Work", url: "https://example.com/hello" },
    ]);
  });

  it.each([null, [], "name", 42, {}, { fullName: "  " }, { fullName: 12 }])(
    "rejects a missing name or non-object/type-invalid input: %j",
    (input) => {
      expect(() => validateProfileCard(input)).toThrow(ProfileValidationError);
    },
  );

  it.each([
    { fullName: "a".repeat(121) },
    { bio: "a".repeat(2001) },
    { email: "not-an-email" },
    { phone: "call me tomorrow" },
    { headline: null },
    { company: {} },
    { fullName: "Ada\nBcc: someone" },
    { email: "me@example.com\r\nBcc: attacker@example.com" },
    { bio: "has a \u0000 byte" },
    { bio: "hidden\u001b[31m terminal escape" },
    { bio: "invalid Unicode \ud800" },
    { email: "invalid\udfff@example.com" },
    { links: "https://example.com" },
    { links: [null] },
    { links: [{ label: "", url: "https://example.com" }] },
    { links: [{ label: "a".repeat(41), url: "https://example.com" }] },
    {
      links: Array.from({ length: 7 }, () => ({
        label: "Work",
        url: "https://example.com",
      })),
    },
    { notes: "private contact notes" },
    { contactId: "contact-1" },
    { published: true },
    {
      links: [
        { label: "Work", url: "https://example.com", secret: "not public" },
      ],
    },
  ])("rejects invalid, oversized, or private fields: %j", (fields) => {
    expect(() => validateProfileCard({ fullName: "Ada", ...fields })).toThrow(
      ProfileValidationError,
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "//example.com",
    "/relative",
    "mailto:me@example.com",
    "https://user:secret@example.com",
    "https://exa\nmple.com",
    "https://example.com/has a space",
    "https://example.com/" + "x".repeat(2048),
  ])("rejects unsafe URL %s", (url) => {
    expect(() =>
      validateProfileCard({ fullName: "Ada", links: [{ label: "Work", url }] }),
    ).toThrow(ProfileValidationError);
  });

  it("does not mutate its input", () => {
    const input = Object.freeze({
      fullName: " Ada ",
      links: Object.freeze([
        Object.freeze({ label: "Work", url: "https://example.com" }),
      ]),
    });
    expect(validateProfileCard(input).fullName).toBe("Ada");
    expect(input.fullName).toBe(" Ada ");
  });
});

describe("parseProfileCardJson", () => {
  it("accepts a portable JSON profile", () => {
    expect(parseProfileCardJson('{"fullName":"Ada"}').fullName).toBe("Ada");
  });

  it("reports bad JSON without echoing input contents", () => {
    expect(() => parseProfileCardJson("{secret-token")).toThrow(
      "Profile must be valid JSON.",
    );
  });

  it("bounds the encoded bytes, not just the number of characters", () => {
    const text = JSON.stringify({
      fullName: "Ada",
      bio: "🙂".repeat(MAX_PROFILE_BYTES / 4),
    });
    expect(text.length).toBeLessThan(MAX_PROFILE_BYTES);
    expect(() => parseProfileCardJson(text)).toThrow(/32 KiB/);
  });
});
