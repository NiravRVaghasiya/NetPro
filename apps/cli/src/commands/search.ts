import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  createEmbeddingProvider,
  isSearchMode,
  searchContacts,
  SEARCH_MODES,
  type SearchContactsOptions,
  type SearchEngineReport,
  type SearchMode,
  type SearchSort,
} from "@netpro/core/src/search";
import { readEmbeddingsConfig } from "./reindex";

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
  // v2.0 Phase 4 — hybrid search. `--semantic` is shorthand for `--mode hybrid`.
  mode?: string;
  semantic?: boolean;
  // v2.0 Phase 5 — derived skills filter (comma-separated, all required).
  skills?: string;
}

/** Split a comma/semicolon list into trimmed, non-empty values (undefined when empty). */
export function parseSkillsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
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

  // `--semantic` upgrades to hybrid; an explicit `--mode` always wins so the
  // two flags can never contradict each other silently.
  let mode: SearchMode | undefined;
  if (opts.mode !== undefined) {
    if (!isSearchMode(opts.mode)) {
      throw new Error(
        `Unknown --mode "${opts.mode}". Expected one of: ${SEARCH_MODES.join(", ")}.`,
      );
    }
    mode = opts.mode;
  } else if (opts.semantic) {
    mode = "hybrid";
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
    skills: parseSkillsFlag(opts.skills),
    sort,
    limit: parseNumber(opts.limit, "limit"),
    offset: parseNumber(opts.offset, "offset"),
    mode,
  };
}

/**
 * One line explaining which engine actually served the results.
 *
 * Printed for keyword/hybrid runs only: the portable default must stay as
 * quiet as it was in v1. When an arm was dropped, say why — "semantic off:
 * no key" is actionable, a silently keyword-only result is not.
 */
export function engineLine(engine: SearchEngineReport): string | null {
  if (engine.requested === "portable") return null;

  const parts: string[] = [];
  const { keyword, semantic } = engine.arms;
  parts.push(keyword.used ? `full-text ${keyword.hits}` : `full-text off (${reasonLabel(keyword.reason)})`);
  if (engine.requested === "hybrid") {
    parts.push(semantic.used ? `semantic ${semantic.hits}` : `semantic off (${reasonLabel(semantic.reason)})`);
  }
  parts.push(`substring ${engine.arms.portable.hits}`);

  const truncated = engine.truncated ? " (candidate pool capped)" : "";
  return `Engine: ${engine.mode} — ${parts.join(", ")}${truncated}`;
}

function reasonLabel(reason: SearchEngineReport["arms"]["keyword"]["reason"]): string {
  switch (reason) {
    case "index_empty":
      return "index empty; run netpro reindex";
    case "index_missing":
      return "index missing; run netpro migrate";
    case "not_configured":
      return "no embeddings key";
    case "no_embeddings":
      return "no vectors; run netpro reindex --embeddings";
    case "provider_error":
      return "provider error";
    default:
      return "not run";
  }
}

function scoreLabel(score: number | null): string {
  if (score === null || score === undefined) return "–";
  return score.toFixed(2);
}

export async function executeSearch(
  options: SearchCommandOptions,
  conn: SqliteConn | PgConn,
  deps: { embedder?: Parameters<typeof searchContacts>[2] } = {},
): Promise<string> {
  const searchOptions = toSearchOptions(options);

  // Only pay for credential resolution when the semantic arm was asked for.
  const embedder =
    deps.embedder ??
    (searchOptions.mode === "hybrid"
      ? { embedder: createEmbeddingProvider(await readEmbeddingsConfig()) }
      : undefined);

  const res = await searchContacts(conn, searchOptions, embedder);

  if (options.json) {
    return JSON.stringify(res, null, 2);
  }

  const engineNote = engineLine(res.engine);

  if (res.contacts.length === 0) {
    const empty = `No contacts match. (${res.total} total matches)`;
    return engineNote ? `${empty}\n${engineNote}` : empty;
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
  if (engineNote) lines.push(engineNote);

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
    .option(
      "--skills <list>",
      "Only contacts whose derived skills include every listed skill (comma-separated; run `netpro skills extract` first)",
    )
    .option("--sort <order>", "relevance | score | recent | name", "relevance")
    .option(
      "--mode <engine>",
      "portable (default) | keyword (adds full-text) | hybrid (adds embeddings)",
    )
    .option("--semantic", "Shorthand for --mode hybrid")
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
