import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  searchContacts,
  type SearchContactsOptions,
  type SearchSort,
} from "@netpro/core/src/search";

export interface SearchCommandOptions {
  query?: string;
  role?: string;
  company?: string;
  location?: string;
  industry?: string;
  seniority?: string;
  // Commander stores hyphenated long flags under camelCase keys.
  hasEmail?: boolean;
  minScore?: string;
  activeWithin?: string;
  sort?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

const VALID_SORTS: SearchSort[] = ["relevance", "score", "recent", "name"];

function parseNumber(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n))
    throw new Error(`--${field} must be a number, got "${value}"`);
  return n;
}

/** Build the core search options from CLI flags, validating as we go. */
export function toSearchOptions(
  opts: SearchCommandOptions,
): SearchContactsOptions {
  const sort = opts.sort as SearchSort | undefined;
  if (sort && !VALID_SORTS.includes(sort)) {
    throw new Error(
      `Unknown --sort "${sort}". Expected one of: ${VALID_SORTS.join(", ")}.`,
    );
  }

  const minScore = parseNumber(opts.minScore, "min-score");
  if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
    throw new Error("--min-score must be between 0 and 1");
  }

  return {
    query: opts.query,
    role: opts.role,
    company: opts.company,
    location: opts.location,
    industry: opts.industry,
    seniority: opts.seniority,
    // Commander delivers hyphenated flags as camelCase (`--has-email` ->
    // `hasEmail`, `--active-within` -> `activeWithin`); read those keys.
    hasEmail: opts.hasEmail,
    minScore,
    lastActiveWithinDays: parseNumber(opts.activeWithin, "active-within"),
    sort,
    limit: parseNumber(opts.limit, "limit"),
    offset: parseNumber(opts.offset, "offset"),
  };
}

function scoreLabel(score: number | null): string {
  if (score === null || score === undefined) return "–";
  return score.toFixed(2);
}

export async function executeSearch(
  options: SearchCommandOptions,
  conn: SqliteConn | PgConn,
): Promise<string> {
  const res = await searchContacts(conn, toSearchOptions(options));

  if (options.json) {
    return JSON.stringify(res, null, 2);
  }

  if (res.contacts.length === 0) {
    return `No contacts match. (${res.total} total matches)`;
  }

  const lines: string[] = [];
  for (const c of res.contacts) {
    const meta = [c.company, c.role, c.location].filter(Boolean).join(" · ");
    lines.push(`${c.fullName}  [score ${scoreLabel(c.relationshipScore)}]`);
    if (meta) lines.push(`   ${meta}`);
    if (c.email) lines.push(`   ${c.email}`);
  }

  const shownRange = `${res.offset + 1}–${Math.min(res.offset + res.contacts.length, res.total)}`;
  lines.push("");
  lines.push(`Showing ${shownRange} of ${res.total} contacts`);
  if (res.total > res.offset + res.contacts.length) {
    lines.push(`(next page: re-run with --offset ${res.offset + res.limit})`);
  }

  // Offer the top facet values as a hint for refining the query.
  const topCompanies = res.facets.company
    .slice(0, 3)
    .map((f) => `${f.value} (${f.count})`);
  if (topCompanies.length > 0) {
    lines.push(`Top companies: ${topCompanies.join(", ")}`);
  }

  return lines.join("\n");
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description(
      "Search your contacts by text, role, company, location, seniority, and more",
    )
    .argument("[query...]", "Free-text search terms")
    .option("--role <role>", "Filter by role/title (substring)")
    .option("--company <company>", "Filter by company (substring)")
    .option("--location <location>", "Filter by location (substring)")
    .option("--industry <industry>", "Filter by industry (substring)")
    .option(
      "--seniority <level>",
      "Filter by seniority (intern|junior|mid|senior|lead|director|vp|c_level)",
    )
    .option("--has-email", "Only contacts with an email address")
    .option("--min-score <0..1>", "Minimum relationship score")
    .option(
      "--active-within <days>",
      "Only contacts active within the last N days",
    )
    .option("--sort <order>", "relevance | score | recent | name", "relevance")
    .option("--limit <n>", "Max results per page", "25")
    .option("--offset <n>", "Skip the first N results (pagination)")
    .option(
      "--json",
      "Print raw JSON (contacts, total, facets) instead of a table",
    )
    .action(async (queryArgs: string[], opts: SearchCommandOptions) => {
      const { openDb } = await import("../db");
      try {
        const merged: SearchCommandOptions = {
          ...opts,
          query: queryArgs.join(" ") || opts.query,
        };
        const output = await executeSearch(merged, await openDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro search: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
