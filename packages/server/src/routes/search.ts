// packages/server/src/routes/search.ts
//
// GET /api/search?q=&company=&role=&location=&industry=&seniority=&hasEmail=&minScore=&activeWithin=&skills=&sort=&limit=&offset=&mode=
// Orchestrates @netpro/core/search — hybrid/portable keyword selection and RRF
// fusion stay in core; the route only translates HTTP → SearchContactsOptions.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  isSearchMode,
  searchContacts,
  SEARCH_MODES,
  type SearchMode,
  type SearchSort,
} from '@netpro/core/src/search';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type SearchDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

const VALID_SORTS: SearchSort[] = ['relevance', 'score', 'recent', 'name'];

function str(v: string | null): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function list(v: string | null): string[] | undefined {
  if (v === null) return undefined;
  const items = v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SearchDeps
): Promise<void> {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;

  const sortParam = str(p.get('sort')) as SearchSort | undefined;
  if (sortParam && !VALID_SORTS.includes(sortParam)) {
    sendJson(res, 400, { error: `Invalid sort \"${sortParam}\"` });
    return;
  }
  const modeParam = str(p.get('mode'));
  if (modeParam !== undefined && !isSearchMode(modeParam)) {
    sendJson(res, 400, {
      error: `Invalid mode \"${modeParam}\". Expected one of: ${SEARCH_MODES.join(', ')}.`,
    });
    return;
  }

  const options = {
    query: str(p.get('q')) ?? str(p.get('query')),
    company: str(p.get('company')),
    role: str(p.get('role')),
    location: str(p.get('location')),
    industry: str(p.get('industry')),
    seniority: str(p.get('seniority')),
    hasEmail: p.get('hasEmail') === 'true',
    minScore: num(p.get('minScore')),
    lastActiveWithinDays: num(p.get('activeWithin')) ?? num(p.get('active_within')) ?? num(p.get('lastActiveWithinDays')),
    skills: list(p.get('skills')),
    sort: sortParam,
    limit: num(p.get('limit')),
    offset: num(p.get('offset')),
    mode: modeParam as SearchMode | undefined,
  };

  try {
    // Embedder is omitted — the local server has no credential surface yet.
    // Keyword mode still works (FTS5 + portable); hybrid degrades gracefully
    // with a semantic arm report of `not_configured`.
    const results = await searchContacts(deps.conn, options, {});
    sendJson(res, 200, results);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const status = (error as { code?: string })?.code === 'invalid_input' ? 400 : 500;
    sendJson(res, status, { error: msg });
  }
}
