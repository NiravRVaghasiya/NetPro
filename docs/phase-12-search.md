# Phase 12 — Search Experience

**Branch:** `arena/01a08ca8-netpro`
**Follows:** [Phase 11 (Network Visualization)](../netpro-local-first-implementation-plan.md#phase-11--network-visualization)
(see `apps/web/app/(app)/network/page.tsx`)

## Objective

Expose NetPro's existing search capabilities through a clear interface —
Name, Company, Role, Location, Skills, Tags, Relationship strength, Community —
and show **why** a result matched:

```text
Sarah Chen

Matched because:
✓ Works at Acme
✓ Has skill: python
✓ Tagged "founder"
✓ Relationship strength 0.85 (minimum 0.5)
```

The UI calls the existing hybrid search implementation; nothing is
reimplemented in React.

---

## What shipped

### Core — new filters (`packages/core/src/search`)

- `SearchContactsOptions` gains `name` (explicit full-name substring),
  `tags` (AND, case-insensitive whole-tag match against the JSON tag list),
  `community` (Louvain membership — label, `Community N`, or 0-based id),
  and `contactIds` (id-set restriction; empty matches nothing).
- `ContactSearchResult` now carries `tags` and `skills` (`string[] | null`),
  parsed per dialect in `fetch.ts` (`parseStringArray`: SQLite json-mode
  arrays and Postgres JSON text collapse to one shape). Surfaces render
  chips and explanations without a second query.
- `resolveCommunityMembers()` (`packages/core/src/graph/communities.ts`)
  resolves a selector to member ids: digits → id, `Community N` → 1-based
  label, exact label, then substring union across labels. Unknown selectors
  return null (match nothing — the same posture as an unknown skill).
- `searchContacts()` resolves `community` once and intersects it as
  `contactIds`, so the portable engine, the keyword/semantic arms, facets,
  and totals all agree.

### Core — match explanations (`packages/core/src/search/explain.ts`)

Pure `explainMatch(contact, options)` attributes each free-text term to the
field(s) it matched (`SEARCHABLE_COLUMNS`, shared with the SQL builder) and
cites each satisfied structured filter. Terms no lexical field explains
(keyword stemming, semantic hits) get an honest `Related to "…"` fallback.
A browse-all query yields no reasons. CLI, server, and Web UI render these
lines verbatim — attribution can never drift between surfaces.

### Server (`packages/server/src/routes/search.ts`)

`GET /api/search` accepts `name`, `tags`, `community` (plus the existing
`q/company/role/location/industry/seniority/hasEmail/minScore/activeWithin/
skills/sort/limit/offset/mode`) and attaches `matchReasons` to every hit via
core's explainer — cheap, pure, additive.

### CLI (`apps/cli/src/commands/search.ts`)

New flags `--name`, `--tags`, `--community`, and `--explain` (prints
`✓ …` lines per hit; with `--json` it attaches `matchReasons`). The list
splitter is now `parseListFlag` (`parseSkillsFlag` kept as an alias).

### Web UI (`apps/web/app/(app)/search/page.tsx`)

Rebuilt server-first: `GET /api/search` with every filter, falling back to
the same core call when `netpro serve` is not running. Result cards show the
score badge, skill/tag chips, and the "Matched because ✓ …" block; the
community input gets a server-fed datalist; facets, engine badge, sort, and
pagination are preserved.

## Exit criteria (plan)

- [x] Name / Company / Role / Location / Skills / Tags / Relationship
      strength / Community are all searchable from the Web UI.
- [x] Every result shows why it matched.
- [x] The UI calls the existing hybrid search (`/api/search` →
      `searchContacts`); no search logic lives in React.

## Tests

- `packages/core/src/search/explain.test.ts` — attribution, filter lines,
  dedupe, `Related to` fallback, honesty rules (never cite a visibly failed
  condition).
- `packages/core/src/search/filters.test.ts` — name/tags/community/
  contactIds against a two-community fixture, including the fused keyword
  path and `parseStringArray` dialect shapes.
- `packages/server/src/api.test.ts` — `matchReasons` on hits; name/tags/
  community/minScore end to end.
- `apps/cli/src/commands/search.test.ts` — flag mapping, `--explain` text
  and JSON output.
- `apps/web/app/(app)/search/page.test.tsx` — server path (query-string
  forwarding, datalist) and fallback path (reasons, chips, every filter).
