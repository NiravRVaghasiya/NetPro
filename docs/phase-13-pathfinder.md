# Phase 13 — Pathfinder

**Branch:** `arena/01a08ca8-netpro`
**Follows:** [Phase 12 — Search Experience](phase-12-search.md)

## Objective

Make *"Who can introduce me to this person?"* a first-class workflow:

```text
You (Ada — origin)
 ↓ colleague
Bob (intermediary)
 ↓ colleague
Cara (target)
```

Every ranked chain shows path strength, weakest relationship, average
relationship, number of hops, and intermediate contacts — using the existing
path-ranking model, never a React reimplementation.

---

## What shipped

### Server (`packages/server/src/routes/graph.ts`)

`GET /api/graph/path` (alias `/api/graph/paths`) fixed and hardened:

- `depth` (BFS hop budget) and `k`/`alt`/`alternatives` (ranked alternatives)
  are parsed independently — an earlier revision fell back to `k` for the
  depth, so `?k=3` silently tripled the hop budget. `limit` only sizes list
  sections again.
- Depth clamps to the documented `PATHFINDER_LIMITS.apiMaxDepth` (6);
  alternatives default to `PATHFINDER_LIMITS.defaultAlternatives` (3) and
  clamp to `maxAlternatives` (5) instead of failing hand-typed URLs.
- `depth=0` / `alt=0` are 400s with `code: "invalid_input"`; missing target
  stays a 400. The response is still core's `IntroPathPlan` (rank, score,
  hops, intermediaries, first ask) — orchestration only.

### CLI (`apps/cli/src/commands/path.ts`)

`netpro path` already used `planIntroPaths`; its per-path line now prints the
first-class summary beside the score — `weakest 0.80 · avg 0.50` (`direct`
for 1-hop chains) — matching the Web UI cards.

### Web UI (`apps/web/app/(app)/pathfinder/page.tsx`)

New first-class page in the primary nav (Observatory · Network · Search ·
**Pathfinder** · People · Activity · Settings):

- **Landing** (no target): the question, the form, graph size, and suggested
  warm-intro candidates with one-click "find this path" links.
- **Results**: one card per ranked chain — Path strength, Weakest
  relationship, Average relationship, Hops, Intermediaries — a vertical
  origin → intermediaries → target stepper (score, last touch, via-relation
  per node), the first-ask suggestion, and "Draft intro request" (existing
  outreach prefill).
- Server-first (`GET /api/graph/path`), core fallback when `netpro serve`
  is down. A server 4xx (unknown contact, bad selector) renders as the
  answer; only network failures and 5xx fall back.
- The contact datalist is fed best-effort from the server (`/api/search`
  top-by-score) with a direct-core fallback.
- Cross-links: Network's "Pathfinder full →", the Observatory's Pathfinder
  entry, and the legacy `/graph` header all point here; `/graph` and
  `/network?target=` keep working until Phase 24.

## Exit criteria (plan)

- [x] "Who can introduce me?" is one click from the primary nav with its own
      landing, form, and results.
- [x] Every chain shows path strength, weakest relationship, average
      relationship, hop count, and intermediate contacts.
- [x] Ranking/scoring/ask come from `planIntroPaths` /
      `rankIntroPaths` — React visualizes, core decides.

## Tests

- `packages/server/src/api.test.ts` — ranked alternatives with strength
  stats; depth/alternatives independence; clamp behavior; 400s.
- `apps/cli/src/commands/path.test.ts` — weakest/avg segments on the
  `#1 …` line.
- `apps/web/app/(app)/pathfinder/page.test.tsx` — landing (candidates,
  empty graph), fallback results (five facts, stepper, ask, draft link,
  strongest-tie default, unreachable, unknown selector), server results,
  and server-4xx passthrough.
