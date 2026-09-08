import { describe, expect, it } from "vitest";
import { CONTENT_LIMITS, ContentError } from "./types";
import {
  fetchFeedText,
  parseContentCsv,
  parseContentDate,
  parseFeedXml,
  parseRfc2822Date,
  splitTagList,
} from "./parse";

describe("parseContentDate", () => {
  it("reads strict ISO via the shared event reader", () => {
    expect(parseContentDate("2026-09-14")).toBe("2026-09-14T00:00:00.000Z");
    expect(parseContentDate("2026-09-14T09:30:00Z")).toBe(
      "2026-09-14T09:30:00.000Z",
    );
    expect(parseContentDate("2026-02-31")).toBe(null);
    expect(parseContentDate("14/03/2026")).toBe(null);
    expect(parseContentDate("")).toBe(null);
    expect(parseContentDate(null)).toBe(null);
  });

  it("reads RFC 2822 feed dates with zones", () => {
    expect(parseRfc2822Date("Mon, 14 Sep 2026 09:30:00 GMT")).toBe(
      "2026-09-14T09:30:00.000Z",
    );
    expect(parseRfc2822Date("Mon, 14 Sep 2026 11:30:00 +0200")).toBe(
      "2026-09-14T09:30:00.000Z",
    );
    expect(parseRfc2822Date("Mon, 14 Sep 2026 09:30 +02:00")).toBe(
      "2026-09-14T07:30:00.000Z",
    );
    expect(parseContentDate("Mon, 14 Sep 2026 09:30:00 GMT")).toBe(
      "2026-09-14T09:30:00.000Z",
    );
  });

  it("rejects ambiguous or impossible feed dates rather than guessing", () => {
    expect(parseRfc2822Date("Mon, 31 Feb 2026 09:30:00 GMT")).toBe(null);
    expect(parseRfc2822Date("Mon, 14 Foo 2026 09:30:00 GMT")).toBe(null);
    expect(parseRfc2822Date("Mon, 14 Sep 2026 09:30:00 EST")).toBe(null);
    expect(parseRfc2822Date("yesterday")).toBe(null);
    expect(parseRfc2822Date("2026-09-14")).toBe(null);
  });
});

describe("splitTagList", () => {
  it("splits cells, dedupes case-insensitively, caps the list", () => {
    expect(splitTagList("js, rust ; js | go")).toEqual({
      tags: ["js", "rust", "go"],
      dropped: 0,
    });
    expect(splitTagList(["a", "b"])).toEqual({ tags: ["a", "b"], dropped: 0 });
    expect(splitTagList(null)).toEqual({ tags: [], dropped: 0 });
    const many = Array.from({ length: 25 }, (_, i) => `t${i}`).join(",");
    const { tags, dropped } = splitTagList(many);
    expect(tags).toHaveLength(CONTENT_LIMITS.tags);
    expect(dropped).toBe(5);
  });
});

describe("parseContentCsv", () => {
  it("parses alias-tolerant headers end to end", () => {
    const csv = [
      "Link,Post Title,Site,Kind,Date,By,Topics,Excerpt",
      'https://example.com/a?utm_source=x,Hello World,Blog,article,2026-09-14,Ada,"js, rust",First post',
    ].join("\n");
    const { rows, errors, warnings } = parseContentCsv(csv);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        url: "https://example.com/a?utm_source=x",
        urlNorm: "https://example.com/a",
        title: "Hello World",
        platform: "blog",
        type: "article",
        publishedAt: "2026-09-14T00:00:00.000Z",
        author: "Ada",
        tags: ["js", "rust"],
        summary: "First post",
      },
    ]);
  });

  it("detects the platform from the host when the cell is empty", () => {
    const csv = ["url,title", "https://dev.to/ada/post,On feeds"].join("\n");
    expect(parseContentCsv(csv).rows[0]).toMatchObject({ platform: "devto" });
    const csv2 = ["url,title", "https://ada.example.com/essay,On blogs"].join(
      "\n",
    );
    expect(parseContentCsv(csv2).rows[0]).toMatchObject({ platform: "blog" });
  });

  it("reports per-row errors without losing the file", () => {
    const csv = [
      "url,title,platform",
      "https://example.com/ok,Good,blog",
      ",Missing URL,blog",
      "not a url,Bad URL,blog",
      "https://example.com/notitle,,blog",
      "https://example.com/badplatform,Bad platform,tiktok",
    ].join("\n");
    const { rows, errors } = parseContentCsv(csv);
    expect(rows.map((r) => r.title)).toEqual(["Good"]);
    expect(errors.map((e) => e.row)).toEqual([3, 4, 5, 6]);
    expect(errors[3]!.reason).toMatch(/Unknown platform/);
  });

  it("warns (not errors) on unparseable dates and unknown types", () => {
    const csv = [
      "url,title,published_at,type,tags",
      `https://example.com/a,A,2026-02-31,hot-take,"${Array.from({ length: 25 }, (_, i) => `t${i}`).join(",")}"`,
    ].join("\n");
    const { rows, errors, warnings } = parseContentCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ publishedAt: null, type: null });
    expect(warnings.map((w) => w.reason)).toEqual([
      expect.stringContaining("unknown type"),
      expect.stringContaining("not a date"),
      expect.stringContaining("excess"),
    ]);
  });

  it("throws only when the file is structurally unusable", () => {
    expect(() => parseContentCsv("")).toThrow(/header/);
    expect(() => parseContentCsv("title\nhello")).toThrow(/no URL column/);
    expect(() => parseContentCsv("url\n")).toThrow(/header/);
  });

  it("caps one file at itemsPerImport", () => {
    const lines = ["url,title"];
    for (let i = 0; i < CONTENT_LIMITS.itemsPerImport + 2; i++) {
      lines.push(`https://example.com/p${i},Post ${i}`);
    }
    const { rows, warnings } = parseContentCsv(lines.join("\n"));
    expect(rows).toHaveLength(CONTENT_LIMITS.itemsPerImport);
    expect(warnings).toHaveLength(2);
  });
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title><![CDATA[Ada's Blog & Notes]]></title>
    <link>https://ada.example.com</link>
    <item>
      <title>Latches &amp; Flip-flops</title>
      <link>https://ada.example.com/latches?utm_source=rss</link>
      <pubDate>Mon, 14 Sep 2026 09:30:00 GMT</pubDate>
      <author>ada@example.com (Ada Lovelace)</author>
      <category>hardware</category>
      <category><![CDATA[history]]></category>
      <description><![CDATA[<p>How the <b>latch</b> was born.</p>]]></description>
    </item>
    <item>
      <title>Linklog</title>
      <link>https://ada.example.com/linklog</link>
      <dc:creator>Grace Hopper</dc:creator>
    </item>
    <item>
      <title>No link here</title>
      <description>nowhere to point</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Feed</title>
  <link href="https://example.org/"/>
  <entry>
    <title>Atom-Powered Robots Run Amok</title>
    <link href="https://example.org/2003/12/13/atom03" rel="alternate"/>
    <link href="https://example.org/2003/12/13/atom03/edit" rel="edit"/>
    <updated>2003-12-13T18:30:02Z</updated>
    <author><name>John Doe</name><email>john@example.org</email></author>
    <category term="robots"/>
    <summary>Some text.</summary>
  </entry>
  <entry>
    <link href="https://example.org/untitled"/>
    <published>2003-12-14T00:00:00Z</published>
  </entry>
</feed>`;

describe("parseFeedXml", () => {
  it("reads RSS 2.0: entities, CDATA, authors, categories, html summaries", () => {
    const feed = parseFeedXml(RSS);
    expect(feed.feed).toEqual({
      title: "Ada's Blog & Notes",
      link: "https://ada.example.com",
    });
    expect(feed.errors).toEqual([]);
    expect(feed.rows).toHaveLength(2);
    expect(feed.rows[0]).toMatchObject({
      url: "https://ada.example.com/latches?utm_source=rss",
      urlNorm: "https://ada.example.com/latches",
      title: "Latches & Flip-flops",
      platform: "rss",
      type: null,
      publishedAt: "2026-09-14T09:30:00.000Z",
      author: "Ada Lovelace",
      tags: ["hardware", "history"],
      summary: "How the latch was born.",
    });
    expect(feed.rows[1]).toMatchObject({
      author: "Grace Hopper",
      publishedAt: null,
      tags: [],
      summary: null,
    });
    expect(feed.warnings).toEqual([
      { row: 3, reason: expect.stringContaining("no link") },
    ]);
  });

  it("reads Atom: rel=alternate links, term categories, untitled fallback", () => {
    const feed = parseFeedXml(ATOM);
    expect(feed.feed).toEqual({
      title: "Example Feed",
      link: "https://example.org/",
    });
    expect(feed.rows).toHaveLength(2);
    expect(feed.rows[0]).toMatchObject({
      url: "https://example.org/2003/12/13/atom03",
      title: "Atom-Powered Robots Run Amok",
      publishedAt: "2003-12-13T18:30:02.000Z",
      author: "John Doe",
      tags: ["robots"],
      summary: "Some text.",
    });
    // No title: the link stands in, so a linkblog feed still imports.
    expect(feed.rows[1]).toMatchObject({
      url: "https://example.org/untitled",
      title: "https://example.org/untitled",
      author: null,
    });
  });

  it("skips entries with unusable links and warns on bad dates", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>Bad date</title><link>https://example.com/d</link><pubDate>someday</pubDate></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
    const feed = parseFeedXml(xml);
    expect(feed.rows.map((r) => r.title)).toEqual(["Bad date"]);
    expect(feed.rows[0]!.publishedAt).toBe(null);
    expect(feed.warnings.map((w) => w.row)).toEqual([1, 2]);
  });

  it("rejects non-feeds and oversized bodies without parsing", () => {
    expect(() => parseFeedXml("<html><body>hello</body></html>")).toThrow(
      /Not a feed/,
    );
    expect(() => parseFeedXml("")).toThrow(ContentError);
    expect(() =>
      parseFeedXml("x".repeat(CONTENT_LIMITS.feedMaxBytes + 1)),
    ).toThrow(/larger than/);
  });

  it("honors a platform override, else detects per link", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>A</title><link>https://dev.to/ada/a</link></item>
      <item><title>B</title><link>https://ada.example.com/b</link></item>
    </channel></rss>`;
    expect(parseFeedXml(xml).rows.map((r) => r.platform)).toEqual([
      "devto",
      "rss",
    ]);
    expect(
      parseFeedXml(xml, { platform: "blog" }).rows.map((r) => r.platform),
    ).toEqual(["blog", "blog"]);
    expect(() => parseFeedXml(xml, { platform: "tiktok" })).toThrow(
      /Unknown platform/,
    );
  });

  it("decodes numeric entities and truncates long fields", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>&#65;&#x42; ${"x".repeat(400)}</title><link>https://example.com/e</link></item>
    </channel></rss>`;
    const title = parseFeedXml(xml).rows[0]!.title;
    expect(title.startsWith("AB ")).toBe(true);
    expect(title).toHaveLength(CONTENT_LIMITS.title);
  });
});

describe("fetchFeedText", () => {
  const stub =
    (
      body: string,
      status = 200,
      contentLength: string | null = String(body.length),
    ) =>
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length" ? contentLength : null,
      },
      text: async () => body,
    });

  it("returns the body through an injected fetch (no network in tests)", async () => {
    const text = await fetchFeedText("https://example.com/feed.xml", {
      fetchImpl: stub("<rss/>"),
    });
    expect(text).toBe("<rss/>");
  });

  it("maps HTTP failures to the house vocabulary", async () => {
    await expect(
      fetchFeedText("https://example.com/feed.xml", {
        fetchImpl: stub("", 404, "0"),
      }),
    ).rejects.toMatchObject({ name: "ContentError", code: "not_found" });
    await expect(
      fetchFeedText("https://example.com/feed.xml", {
        fetchImpl: stub("", 500, "0"),
      }),
    ).rejects.toMatchObject({ name: "ContentError", code: "invalid_input" });
  });

  it("refuses oversized bodies before and after reading", async () => {
    await expect(
      fetchFeedText("https://example.com/feed.xml", {
        fetchImpl: stub("tiny", 200, String(CONTENT_LIMITS.feedMaxBytes + 1)),
      }),
    ).rejects.toThrow(/declares/);
    await expect(
      fetchFeedText("https://example.com/feed.xml", {
        fetchImpl: stub("x".repeat(100), 200, null),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/larger than/);
  });

  it("rejects non-URLs without calling fetch", async () => {
    let called = false;
    const fetchImpl: Parameters<typeof fetchFeedText>[1] = {
      fetchImpl: async () => {
        called = true;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
        };
      },
    };
    await expect(fetchFeedText("not a url", fetchImpl)).rejects.toThrow(
      ContentError,
    );
    expect(called).toBe(false);
  });

  it("turns a network throw into a ContentError", async () => {
    await expect(
      fetchFeedText("https://example.com/feed.xml", {
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/Could not fetch the feed \(getaddrinfo ENOTFOUND\)/);
  });
});
