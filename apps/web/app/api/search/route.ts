import { NextResponse } from "next/server";
import { conn } from "@/lib/db";
import {
  searchContacts,
  type SearchContactsOptions,
  type SearchSort,
} from "@netpro/core/src/search";

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
  };

  try {
    const results = await searchContacts(conn, options);
    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
