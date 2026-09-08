// packages/core/src/content/parse.ts
//
// The content reader. Pure: text in, rows out, no database — so the same
// parser backs `netpro content import`, the Phase 5 web upload, and the
// tests. Two grammars, one row shape:
//
//   * CSV — the owner's own spreadsheet (`url,title,platform,…`), headers
//     resolved through an alias table like the event importer;
//   * RSS 2.0 / Atom — a feed body, parsed with a dependency-free reader
//     (no XML library: feeds are machine-generated and the fields NetPro
//     needs are shallow).
//
// The only network in the module is `fetchFeedText`: an injectable fetch
// with a byte cap and a timeout, so production can pull a feed URL and tests
// never touch the network.
import Papa from "papaparse";
import { parseEventDate } from "../events/parse";
import { detectPlatform, normalizeContentUrl, parsePlatform } from "./urls";
import {
  CONTENT_LIMITS,
  CONTENT_TYPES,
  ContentError,
  type ContentPlatform,
  type ContentType,
} from "./types";

export interface ParsedContentRow {
  /** The link as given — kept for display. */
  url: string;
  /** The canonical dedupe key (`url_norm`). */
  urlNorm: string;
  title: string;
  platform: ContentPlatform;
  type: ContentType | null;
  publishedAt: string | null;
  author: string | null;
  tags: string[];
  summary: string | null;
}

export interface ParseContentResult {
  rows: ParsedContentRow[];
  /** Fatal for the row: it is skipped and reported. */
  errors: Array<{ row: number; reason: string }>;
  /** Non-fatal: the row imported, but something in it was dropped. */
  warnings: Array<{ row: number; reason: string }>;
}

export interface ParsedFeed extends ParseContentResult {
  feed: { title: string | null; link: string | null };
}

// ── Dates ────────────────────────────────────────────────────────────────

const RFC2822_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * `Mon, 02 Jan 2006 15:04:05 GMT` / `+0200` / `+02:00` — the shape RSS
 * `pubDate` uses. Single-letter military zones are rejected (ambiguous),
 * anything else falls through to `null` rather than a guessed date.
 */
export function parseRfc2822Date(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(
    /^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$/,
  );
  if (!m) return null;
  const month = RFC2822_MONTHS[m[2]!.toLowerCase()];
  if (month === undefined) return null;
  const year = Number(m[3]);
  const day = Number(m[1]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? "0");
  if (year < 1900 || year > 2200) return null;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return null;

  const zone = m[7]!.trim().toUpperCase();
  let offsetMs = 0;
  if (zone !== "GMT" && zone !== "UT" && zone !== "UTC" && zone !== "Z") {
    const z = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!z) return null;
    const zh = Number(z[2]);
    const zm = Number(z[3]);
    if (zh > 23 || zm > 59) return null;
    offsetMs = (z[1] === "-" ? 1 : -1) * (zh * 60 + zm) * 60_000;
  }

  const ms = Date.UTC(year, month, day, hour, minute, second) + offsetMs;
  const probe = new Date(ms - offsetMs);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Whatever a CSV cell or a feed hands over: strict ISO first (the event
 * importer's reader, so `2026-02-31` is still rejected, not rolled), then
 * RFC 2822 for RSS `pubDate`. Anything else is `null` — the caller decides
 * whether that is a row error (events) or a warning + undated item (content).
 */
export function parseContentDate(
  raw: string | null | undefined,
): string | null {
  return parseEventDate(raw) ?? parseRfc2822Date(raw);
}

// ── Small shared coercions ───────────────────────────────────────────────

function capped(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/**
 * Split a tag/category cell on `,` `;` `|` (feeds hand over one category per
 * element; spreadsheets cram them in one cell). Each tag truncated to its
 * cap, the list to its cap; the caller reports the drop.
 */
export function splitTagList(value: string | string[] | null | undefined): {
  tags: string[];
  dropped: number;
} {
  const raw: string[] =
    value === null || value === undefined
      ? []
      : Array.isArray(value)
        ? value
        : value.split(/[,;|]+/);
  const tags: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const piece of raw) {
    const tag = piece.trim().slice(0, CONTENT_LIMITS.tagLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (tags.length >= CONTENT_LIMITS.tags) {
      dropped++;
      continue;
    }
    tags.push(tag);
  }
  return { tags, dropped };
}

function parseTypeCell(raw: string | null | undefined): {
  type: ContentType | null;
  warning: string | null;
} {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) return { type: null, warning: null };
  if ((CONTENT_TYPES as readonly string[]).includes(value)) {
    return { type: value as ContentType, warning: null };
  }
  return {
    type: null,
    warning: `unknown type "${raw!.trim()}" ignored (expected one of: ${CONTENT_TYPES.join(", ")}).`,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────

type Field =
  | "url"
  | "title"
  | "platform"
  | "type"
  | "publishedAt"
  | "author"
  | "tags"
  | "summary";

const ALIASES: Record<Field, readonly string[]> = {
  url: ["url", "link", "href", "permalink", "post url", "article url"],
  title: [
    "title",
    "name",
    "headline",
    "post",
    "post title",
    "article",
    "video",
  ],
  platform: ["platform", "site", "network", "channel", "service"],
  type: ["type", "kind", "format", "medium"],
  publishedAt: [
    "published at",
    "published",
    "date",
    "posted",
    "posted at",
    "created",
    "pubdate",
    "pub date",
  ],
  author: ["author", "by", "writer", "creator"],
  tags: [
    "tags",
    "tag",
    "categories",
    "category",
    "topics",
    "topic",
    "labels",
    "keywords",
  ],
  summary: ["summary", "description", "excerpt", "subtitle", "dek", "notes"],
};

const FALLBACKS: Record<Field, RegExp> = {
  url: /(url|link|href|permalink)/,
  title: /(title|headline|^name$)/,
  platform: /(platform|site|network|channel)/,
  type: /(^type$|kind|format)/,
  publishedAt: /(publish|date|posted|created)/,
  author: /(author|writer|creator|byline)/,
  tags: /(tags?|categor|topics?|labels?|keywords?)/,
  summary: /(summary|description|excerpt|subtitle|notes?)/,
};

const RESOLUTION_ORDER: Field[] = [
  "url",
  "publishedAt",
  "platform",
  "tags",
  "author",
  "type",
  "summary",
  "title",
];

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveHeaders(headers: string[]): Partial<Record<Field, string>> {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const out: Partial<Record<Field, string>> = {};
  const taken = new Set<string>();

  for (const field of RESOLUTION_ORDER) {
    for (const alias of ALIASES[field]) {
      const hit = normalized.find((h) => !taken.has(h.raw) && h.key === alias);
      if (hit) {
        out[field] = hit.raw;
        taken.add(hit.raw);
        break;
      }
    }
  }
  for (const field of RESOLUTION_ORDER) {
    if (out[field]) continue;
    const hit = normalized.find(
      (h) => !taken.has(h.raw) && FALLBACKS[field].test(h.key),
    );
    if (hit) {
      out[field] = hit.raw;
      taken.add(hit.raw);
    }
  }
  return out;
}

/**
 * Parse a content CSV into rows ready to import.
 *
 * Throws only when the file is structurally unusable (no header, no URL
 * column, no rows); per-row problems come back in `errors`/`warnings` so one
 * bad line never costs the whole file.
 */
export function parseContentCsv(csv: string): ParseContentResult {
  const parsed = Papa.parse<Record<string, string | undefined>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = (parsed.meta.fields ?? []).filter(
    (h): h is string => typeof h === "string",
  );
  if (headers.length === 0 || parsed.data.length === 0) {
    throw new ContentError(
      "invalid_input",
      'CSV is empty or missing a header row (expected at least a "url" column).',
    );
  }

  const cols = resolveHeaders(headers);
  if (!cols.url) {
    throw new ContentError(
      "invalid_input",
      `CSV has no URL column. Expected one of: ${ALIASES.url.join(", ")}.`,
    );
  }

  const rows: ParsedContentRow[] = [];
  const errors: ParseContentResult["errors"] = [];
  const warnings: ParseContentResult["warnings"] = [];

  for (const [index, row] of parsed.data.entries()) {
    const line = index + 2; // 1-based header + 0-based data index
    if (index >= CONTENT_LIMITS.itemsPerImport) {
      warnings.push({
        row: line,
        reason: `skipped: only the first ${CONTENT_LIMITS.itemsPerImport} rows of one file are imported.`,
      });
      continue;
    }

    const urlRaw = cols.url ? (row[cols.url]?.trim() ?? "") : "";
    if (!urlRaw) {
      errors.push({ row: line, reason: "URL is required" });
      continue;
    }
    let urlNorm: string;
    try {
      urlNorm = normalizeContentUrl(urlRaw);
    } catch (error) {
      errors.push({
        row: line,
        reason:
          error instanceof ContentError ? error.message : "URL is not usable",
      });
      continue;
    }

    const title = cols.title
      ? capped(row[cols.title], CONTENT_LIMITS.title)
      : null;
    if (!title) {
      errors.push({ row: line, reason: "title is required" });
      continue;
    }

    const platformRaw = cols.platform ? (row[cols.platform]?.trim() ?? "") : "";
    let platform: ContentPlatform;
    if (!platformRaw) {
      platform = detectPlatform(urlRaw) ?? "blog";
    } else {
      try {
        platform = parsePlatform(platformRaw);
      } catch (error) {
        errors.push({
          row: line,
          reason:
            error instanceof ContentError ? error.message : "unknown platform",
        });
        continue;
      }
    }

    const { type, warning: typeWarning } = parseTypeCell(
      cols.type ? row[cols.type] : null,
    );
    if (typeWarning) warnings.push({ row: line, reason: typeWarning });

    const dateRaw = cols.publishedAt ? capped(row[cols.publishedAt], 64) : null;
    const publishedAt = parseContentDate(dateRaw);
    if (dateRaw && !publishedAt) {
      // An undated post is still a post: warn and keep the row, unlike the
      // event importer, where a bad date defines the thing being imported.
      warnings.push({
        row: line,
        reason: `"${dateRaw}" is not a date NetPro can read (use YYYY-MM-DD) — imported undated.`,
      });
    }

    const { tags, dropped } = splitTagList(cols.tags ? row[cols.tags] : null);
    if (dropped > 0) {
      warnings.push({
        row: line,
        reason: `${dropped} excess ${dropped === 1 ? "tag" : "tags"} dropped (max ${CONTENT_LIMITS.tags}).`,
      });
    }

    rows.push({
      url: urlRaw.slice(0, CONTENT_LIMITS.url),
      urlNorm,
      title,
      platform,
      type,
      publishedAt,
      author: cols.author
        ? capped(row[cols.author], CONTENT_LIMITS.author)
        : null,
      tags,
      summary: cols.summary
        ? capped(row[cols.summary], CONTENT_LIMITS.summary)
        : null,
    });
  }

  return { rows, errors, warnings };
}

// ── Feeds (RSS 2.0 + Atom, dependency-free) ──────────────────────────────

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(text: string): string {
  return unwrapCdata(text)
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) =>
      name === "amp"
        ? "&"
        : name === "lt"
          ? "<"
          : name === "gt"
            ? ">"
            : name === "quot"
              ? '"'
              : "'",
    )
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : `&#${code};`;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : `&#x${code};`;
    });
}

function plainText(
  html: string | null | undefined,
  max: number,
): string | null {
  if (html === null || html === undefined) return null;
  const text = decodeEntities(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text.slice(0, max);
}

/** First `<name …>…</name>` inner text, case-insensitive, attributes allowed. */
function tagInner(block: string, names: string[]): string | null {
  for (const name of names) {
    const m = block.match(
      new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"),
    );
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Every `<name …>…</name>` inner text (RSS categories). */
function tagAllInner(block: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    if (out.length >= CONTENT_LIMITS.tags * 2) break;
  }
  return out;
}

/** Every `term="…"` on `<category …>` elements (Atom categories). */
function categoryTerms(block: string): string[] {
  const out: string[] = [];
  const re = /<category\s[^>]*\bterm=(["'])(.*?)\1[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[2] !== undefined) out.push(m[2]);
    if (out.length >= CONTENT_LIMITS.tags * 2) break;
  }
  // Bare `<category>text</category>` (RSS-style inside an Atom feed — it happens).
  for (const inner of tagAllInner(block, "category")) {
    const text = plainText(inner, CONTENT_LIMITS.tagLength);
    if (text) out.push(text);
    if (out.length >= CONTENT_LIMITS.tags * 2) break;
  }
  return out;
}

/**
 * An Atom entry's link: `rel="alternate"` wins, else the first `href`, else
 * a bare `<link>text</link>`. RSS items use plain `<link>text</link>`, which
 * the same reader handles as the fallback.
 */
function entryLink(block: string): string | null {
  const links: Array<{ href: string | null; rel: string | null }> = [];
  const re = /<link(\s[^>]*)?\/?>([^<]*<\/link>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1] ?? "";
    const href = attrs.match(/\bhref=(["'])(.*?)\1/i)?.[2] ?? null;
    const rel = attrs.match(/\brel=(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? null;
    const text = (m[2] ?? "").replace(/<\/link>/i, "").trim() || null;
    links.push({ href: href ?? text, rel });
    if (links.length >= 10) break;
  }
  if (links.length === 0) return null;
  return (
    links.find((l) => l.href && (l.rel === null || l.rel === "alternate"))
      ?.href ??
    links.find((l) => l.href)?.href ??
    null
  );
}

function entryAuthor(block: string, kind: "rss" | "atom"): string | null {
  if (kind === "atom") {
    const authorBlock = tagInner(block, ["author"]);
    const name = authorBlock ? tagInner(authorBlock, ["name"]) : null;
    const fallback =
      name ?? (authorBlock && !authorBlock.includes("<") ? authorBlock : null);
    return plainText(fallback, CONTENT_LIMITS.author);
  }
  const raw = tagInner(block, ["author", "dc:creator", "creator"]);
  if (!raw) return null;
  const text = plainText(raw, CONTENT_LIMITS.author);
  if (!text) return null;
  // RSS authors are often `ada@engines.dev (Ada Lovelace)` — prefer the name.
  return text.match(/\(([^()]*)\)\s*$/)?.[1]?.trim() || text;
}

/**
 * Parse an RSS 2.0 or Atom feed body into rows ready to import.
 *
 * Items without a usable link are skipped (with a warning) — a post NetPro
 * cannot link to cannot be deduped. Items without a title take the link as
 * the title, so a bare linkblog feed still imports.
 */
export function parseFeedXml(
  xml: string,
  opts: { platform?: ContentPlatform | string; now?: Date } = {},
): ParsedFeed {
  if (xml.length > CONTENT_LIMITS.feedMaxBytes) {
    throw new ContentError(
      "invalid_input",
      `Feed body is larger than ${CONTENT_LIMITS.feedMaxBytes} bytes — refusing to parse.`,
    );
  }
  const isRss = /<(rss|channel)(\s|>)/i.test(xml);
  const isAtom = /<feed(\s|>)/i.test(xml);
  if (!isRss && !isAtom) {
    throw new ContentError(
      "invalid_input",
      "Not a feed NetPro can read (expected RSS 2.0 or Atom XML).",
    );
  }
  const kind: "rss" | "atom" = isRss ? "rss" : "atom";

  const headEnd =
    kind === "rss" ? xml.search(/<item(\s|>)/i) : xml.search(/<entry(\s|>)/i);
  const head = headEnd === -1 ? xml : xml.slice(0, headEnd);
  const feedTitle =
    kind === "rss"
      ? plainText(tagInner(head, ["title"]), CONTENT_LIMITS.title)
      : plainText(tagInner(head, ["title"]), CONTENT_LIMITS.title);
  const feedLink =
    kind === "rss"
      ? plainText(tagInner(head, ["link"]), CONTENT_LIMITS.url)
      : entryLink(head);

  const blocks: string[] = [];
  const re =
    kind === "rss"
      ? /<item(\s[^>]*)?>([\s\S]*?)<\/item>/gi
      : /<entry(\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[2] ?? "");
  }

  const feedPlatform =
    opts.platform !== undefined &&
    opts.platform !== null &&
    opts.platform !== ""
      ? parsePlatform(String(opts.platform))
      : null;

  const rows: ParsedContentRow[] = [];
  const warnings: ParsedFeed["warnings"] = [];

  for (const [index, block] of blocks.entries()) {
    const n = index + 1;
    if (index >= CONTENT_LIMITS.itemsPerImport) {
      // One summary warning, not one per skipped entry: feeds are
      // machine-generated bulk, and 9,000 identical warnings help nobody.
      warnings.push({
        row: 0,
        reason: `only the first ${CONTENT_LIMITS.itemsPerImport} entries were read (${blocks.length - index} skipped).`,
      });
      break;
    }

    const linkRaw =
      (kind === "rss"
        ? plainText(tagInner(block, ["link"]), CONTENT_LIMITS.url)
        : entryLink(block)?.trim()) ?? "";
    if (!linkRaw) {
      warnings.push({
        row: n,
        reason: "entry has no link — skipped (nothing to dedupe on).",
      });
      continue;
    }
    let urlNorm: string;
    try {
      urlNorm = normalizeContentUrl(linkRaw);
    } catch (error) {
      warnings.push({
        row: n,
        reason:
          error instanceof ContentError
            ? error.message
            : "entry link is not usable — skipped.",
      });
      continue;
    }

    const title =
      plainText(
        kind === "rss"
          ? tagInner(block, ["title"])
          : tagInner(block, ["title"]),
        CONTENT_LIMITS.title,
      ) ?? linkRaw.slice(0, CONTENT_LIMITS.title);

    const dateRaw =
      kind === "rss"
        ? plainText(tagInner(block, ["pubDate", "dc:date", "date"]), 64)
        : plainText(tagInner(block, ["published", "updated"]), 64);
    const publishedAt = parseContentDate(dateRaw);
    if (dateRaw && !publishedAt) {
      warnings.push({
        row: n,
        reason: `"${dateRaw}" is not a date NetPro can read — imported undated.`,
      });
    }

    const rawTags =
      kind === "rss"
        ? tagAllInner(block, "category").map((c) => decodeEntities(c))
        : categoryTerms(block).map((c) => decodeEntities(c));
    const { tags, dropped } = splitTagList(rawTags);
    if (dropped > 0) {
      warnings.push({
        row: n,
        reason: `${dropped} excess ${dropped === 1 ? "tag" : "tags"} dropped (max ${CONTENT_LIMITS.tags}).`,
      });
    }

    const summary =
      kind === "rss"
        ? plainText(
            tagInner(block, ["content:encoded", "description", "summary"]),
            CONTENT_LIMITS.summary,
          )
        : plainText(
            tagInner(block, ["summary", "content"]),
            CONTENT_LIMITS.summary,
          );

    rows.push({
      url: linkRaw.slice(0, CONTENT_LIMITS.url),
      urlNorm,
      title,
      platform: feedPlatform ?? detectPlatform(linkRaw) ?? "rss",
      type: null,
      publishedAt,
      author: entryAuthor(block, kind),
      tags,
      summary,
    });
  }

  return {
    feed: { title: feedTitle, link: feedLink },
    rows,
    errors: [],
    warnings,
  };
}

// ── Fetch (the module's one network call) ────────────────────────────────

export interface FetchFeedTextOptions {
  /** Injectable fetch — tests hand over a stub, production the global. */
  fetchImpl?: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Pull a feed URL into text. Bounded three ways: an explicit timeout, a
 * `Content-Length` gate before reading, and a post-read size check (for
 * servers that lie about the length). Throws `ContentError`, never a raw
 * network error, so callers only handle one vocabulary.
 */
export async function fetchFeedText(
  url: string,
  opts: FetchFeedTextOptions = {},
): Promise<string> {
  const target = url.trim();
  try {
    normalizeContentUrl(target);
  } catch (error) {
    throw error instanceof ContentError
      ? error
      : new ContentError("invalid_input", "Feed URL is not usable.");
  }
  const timeoutMs = opts.timeoutMs ?? CONTENT_LIMITS.feedTimeoutMs;
  const maxBytes = opts.maxBytes ?? CONTENT_LIMITS.feedMaxBytes;
  const fetchImpl =
    opts.fetchImpl ??
    (typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : null);
  if (!fetchImpl) {
    throw new ContentError(
      "not_configured",
      "No fetch implementation is available.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    let res: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      res = await fetchImpl(target, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ContentError(
          "invalid_input",
          `Fetching the feed timed out after ${timeoutMs} ms.`,
        );
      }
      throw new ContentError(
        "invalid_input",
        `Could not fetch the feed (${error instanceof Error ? error.message : "network error"}).`,
      );
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new ContentError("not_found", `No feed at ${target} (HTTP 404).`);
      }
      throw new ContentError(
        "invalid_input",
        `Fetching the feed failed (HTTP ${res.status}).`,
      );
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ContentError(
        "invalid_input",
        `Feed body declares ${declared} bytes (max ${maxBytes}) — refusing to read.`,
      );
    }
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new ContentError(
        "invalid_input",
        `Feed body is larger than ${maxBytes} bytes — refusing to parse.`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
