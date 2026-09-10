// packages/server/src/routes/search.ts
//
// GET /api/search?q=&name=&company=&role=&location=&industry=&seniority=&hasEmail=&minScore=&activeWithin=&skills=&tags=&community=&sort=&limit=&offset=&mode=
// Orchestrates @netpro/core/search — hybrid/portable keyword selection and RRF
// fusion stay in core; the route only translates HTTP → SearchContactsOptions.
// Phase 8: search operations emit `search.started` / `search.completed` /
// `search.failed` events so the Activity feed and Observatory can show that
// NetPro is working, even for instant queries.
// Phase 12: every contact carries `matchReasons` (core's pure explainMatch),
// so the Web UI can show WHY a result matched without duplicating attribution.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  explainMatch,
  isSearchMode,
  searchContacts,
  SEARCH_MODES,
  type SearchMode,
  type SearchSort,
} from '@netpro/core/src/search';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';
import type { EventBus } from '../events/index';

export type SearchDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  events?: EventBus;
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
    sendJson(res, 400, { error: `Invalid sort "${sortParam}"` });
    return;
  }
  const modeParam = str(p.get('mode'));
  if (modeParam !== undefined && !isSearchMode(modeParam)) {
    sendJson(res, 400, {
      error: `Invalid mode "${modeParam}". Expected one of: ${SEARCH_MODES.join(', ')}.`,
    });
    return;
  }

  const options = {
    query: str(p.get('q')) ?? str(p.get('query')),
    name: str(p.get('name')),
    company: str(p.get('company')),
    role: str(p.get('role')),
    location: str(p.get('location')),
    industry: str(p.get('industry')),
    seniority: str(p.get('seniority')),
    hasEmail: p.get('hasEmail') === 'true' ? true : undefined,
    minScore: num(p.get('minScore')),
    lastActiveWithinDays: num(p.get('activeWithin')) ?? num(p.get('active_within')) ?? num(p.get('lastActiveWithinDays')),
    skills: list(p.get('skills')),
    tags: list(p.get('tags')),
    community: str(p.get('community')),
    sort: sortParam,
    limit: num(p.get('limit')),
    offset: num(p.get('offset')),
    mode: modeParam as SearchMode | undefined,
  };

  // Phase 8 — let the UI know a search is happening. The query itself is
  // included as `message` so the Activity feed can answer "what did NetPro
  // just search for?" without parsing another endpoint.
  const searchId = `search_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  deps.events?.publish({
    type: 'search.started',
    jobId: searchId,
    message: options.query ?? options.company ?? options.role ?? 'search',
    query: options.query,
    mode: options.mode,
  });

  try {
    // Embedder is omitted — the local server has no credential surface yet.
    // Keyword mode still works (FTS5 + portable); hybrid degrades gracefully
    // with a semantic arm report of `not_configured`.
    const results = await searchContacts(deps.conn, options, {});
    // Phase 12 — attribute every hit with core's pure explainer. Cheap (no
    // I/O), additive (existing clients ignore the key), and identical to
    // what `netpro search --explain` prints.
    const contacts = results.contacts.map((c) => ({
      ...c,
      matchReasons: explainMatch(c, options),
    }));
    deps.events?.publish({
      type: 'search.completed',
      jobId: searchId,
      message: `Found ${results.total} results`,
      total: results.total,
      query: options.query,
    });
    sendJson(res, 200, { ...results, contacts });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const status = (error as { code?: string })?.code === 'invalid_input' ? 400 : 500;
    deps.events?.publish({
      type: 'job.failed',
      jobId: searchId,
      error: msg,
      message: `Search failed: ${msg}`,
    });
    sendJson(res, status, { error: msg });
  }
}
