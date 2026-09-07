import { NextResponse } from "next/server";
import { conn } from "@/lib/db";
import {
  isSearchMode,
  searchContacts,
  SEARCH_MODES,
  type SearchContactsOptions,
  type SearchMode,
  type SearchSort,
} from "@netpro/core/src/search";
import { searchEmbedder } from "@/lib/search-config";

const VALID_SORTS: SearchSort[] = ["relevance", "score", "recent", "name"];

function num(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function str(value: string | null): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const p = url.searchParams;

  const sortParam = str(p.get("sort")) as SearchSort | undefined;
  if (sortParam && !VALID_SORTS.includes(sortParam)) {
    return NextResponse.json(
      { error: `Invalid sort "${sortParam}"` },
      { status: 400 },
    );
  }

  // v2.0 Phase 4. Unknown modes are a 400 rather than a silent downgrade: a
  // caller asking for `mode=vector` has a bug, and quietly serving substring
  // results would hide it.
  const modeParam = str(p.get("mode"));
  if (modeParam !== undefined && !isSearchMode(modeParam)) {
    return NextResponse.json(
      {
        error: `Invalid mode "${modeParam}". Expected one of: ${SEARCH_MODES.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const mode = modeParam as SearchMode | undefined;

  const options: SearchContactsOptions = {
    query: str(p.get("q")),
    company: str(p.get("company")),
    role: str(p.get("role")),
    location: str(p.get("location")),
    industry: str(p.get("industry")),
    seniority: str(p.get("seniority")),
    hasEmail: p.get("hasEmail") === "true",
    minScore: num(p.get("minScore")),
    lastActiveWithinDays: num(p.get("activeWithin")),
    sort: sortParam,
    limit: num(p.get("limit")),
    offset: num(p.get("offset")),
    mode,
  };

  try {
    // Build the embedder only for a hybrid request — the portable and keyword
    // paths must not depend on credentials existing.
    const results = await searchContacts(
      conn,
      options,
      mode === "hybrid" ? { embedder: searchEmbedder() } : {},
    );
    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
