import { describe, expect, it } from "vitest";
import { renderProfileCardHtml } from "./html";
import { renderProfileVCard } from "./vcard";
import { validateProfileCard } from "./validation";

const profile = validateProfileCard({
  fullName: "Ada Lovelace",
  headline: "Software, with a human side.",
  company: "Analytical Engines",
  role: "Engineer",
  location: "London",
  email: "ada+work@example.com",
  phone: "+44 20 1234 5678",
  bio: "Building useful things.\nAlways learning.",
  links: [{ label: "My work", url: "https://example.com/work" }],
});

describe("standalone profile HTML", () => {
  it("embeds the view pixel only when explicitly requested", () => {
    const html = renderProfileCardHtml(profile, {
      pixelUrl: "https://net.example/api/card/pixel.gif?p=blog",
    });
    expect(html).toContain(
      '<img src="https://net.example/api/card/pixel.gif?p=blog" width="1" height="1" alt="" aria-hidden="true"',
    );
    expect(html).toContain('default-src \'none\'; img-src https://net.example');
    expect(() =>
      renderProfileCardHtml(profile, { pixelUrl: "javascript:alert(1)" }),
    ).toThrow(/absolute http/);
    expect(() => renderProfileCardHtml(profile, { pixelUrl: "/relative" })).toThrow(
      /absolute http/,
    );
  });

  it("is a complete offline page with contact actions and a downloadable vCard", () => {
    const html = renderProfileCardHtml(profile);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("mailto:ada%2Bwork@example.com");
    expect(html).toContain('href="https://example.com/work"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('download="contact.vcf"');
    expect(html).toContain("data:text/vcard;charset=utf-8,");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toMatch(/<script|<iframe|<img|<link[^>]+stylesheet/);
  });

  it("escapes text and attributes; encoded email cannot inject mail headers", () => {
    const html = renderProfileCardHtml(
      validateProfileCard({
        fullName: '<script>alert("XSS")</script>',
        bio: '<img src=x onerror="alert(1)"> & hello',
        email: "ada?subject=surprise@example.com",
        links: [{ label: "<b>Work</b>", url: "https://example.com/?a=1&b=2" }],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Work&lt;/b&gt;");
    expect(html).toContain("?a=1&amp;b=2");
    expect(html).toContain("mailto:ada%3Fsubject%3Dsurprise@example.com");
    expect(html).not.toContain("mailto:ada?subject");
  });

  it("validates even when an unsafe object is passed by a non-TypeScript caller", () => {
    expect(() =>
      renderProfileCardHtml({
        ...profile,
        links: [{ label: "bad", url: "javascript:alert(1)" }],
      }),
    ).toThrow(/HTTP/);
  });
});

describe("vCard 3.0", () => {
  it("contains only the profile's public fields with CRLF line endings", () => {
    const vcard = renderProfileVCard(profile);
    expect(vcard).toMatch(/^BEGIN:VCARD\r\nVERSION:3.0\r\n/);
    expect(vcard).toContain("FN:Ada Lovelace\r\n");
    expect(vcard).toContain("N:;Ada Lovelace;;;\r\n");
    expect(vcard).toContain("ORG:Analytical Engines\r\n");
    expect(vcard).toContain("TITLE:Engineer\r\n");
    expect(vcard).toContain("EMAIL;TYPE=INTERNET:ada+work@example.com\r\n");
    expect(vcard).toContain(
      "NOTE:Building useful things.\\nAlways learning.\r\n",
    );
    expect(vcard).toMatch(/END:VCARD\r\n$/);
    expect(vcard.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("escapes delimiters and prevents property injection through a biography", () => {
    const vcard = renderProfileVCard({
      ...profile,
      fullName: "Ada; Countess, Lovelace\\",
      bio: "hello\nEMAIL:injected@example.com",
    });
    expect(vcard).toContain("FN:Ada\\; Countess\\, Lovelace\\\\\r\n");
    expect(vcard).toContain("NOTE:hello\\nEMAIL:injected@example.com");
    expect(vcard).not.toContain("\r\nEMAIL:injected");
  });

  it("folds long lines at 75 UTF-8 octets without splitting code points", () => {
    const bio = "こんにちは🙂 café, ".repeat(40);
    const vcard = renderProfileVCard({ ...profile, bio });
    for (const line of vcard.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      expect(line).not.toContain("\ufffd");
    }
    expect(vcard).toContain("\r\n ");
    const unfolded = vcard.replace(/\r\n /g, "");
    expect(unfolded).toContain(`NOTE:${bio.trim().replace(/,/g, "\\,")}`);
  });

  it("omits absent optional fields", () => {
    const vcard = renderProfileVCard(validateProfileCard({ fullName: "Ada" }));
    expect(vcard).not.toMatch(/EMAIL|TEL|ORG|NOTE|URL/);
  });
});
