# Capability matrix

Maps every v3.0.2 capability to its TypeScript owner, surfaces, and the Python phase that should take it over. **One business rule, one implementation** — Python must replace the core module, not add a second copy beside it.

Legend:

- **Core** — `@netpro/core` module (authoritative logic)
- **DB** — schema / migrations in `@netpro/db`
- **Server** — HTTP orchestration only
- **CLI** — `apps/cli` command
- **Web** — `apps/web` page (pure client)
- **Python phase** — from `NetPro_Python_First_Implementation_Plan.md`

| ID | Capability | Core | DB | Server | CLI | Web | Python phase | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | Local install (`~/.netpro`, config.toml, identity) | — | `local.ts`, `identity.ts` | config load | `init`, `status`, `config`, `token` | — | 1, 13 | TOML subset parser; 0700/0600 perms |
| C02 | Dual-dialect persistence | — | schema + `createDb` | uses conn | `migrate` | — | **2** | SQLite WAL / PG pool; do not redesign |
| C03 | Migrations | — | `migrate.ts` (15×2) | auto-migrate on serve | `migrate --status` | — | 2 | PG advisory lock; apply twice = no-op |
| C04 | Backup / restore | — | `backup.ts` | — | `backup`, `restore` | — | 7 | SQLite file copy; `pg_dump`/`pg_restore` |
| C05 | LinkedIn CSV import | `import/` | `contacts`, `edges` | `POST /api/import` | `import` | Import | 6, 7 | Preview/validate; never auto-confirm mutuals |
| C06 | LinkedIn URL add-person | `import/linkedin-url.ts`, `crm/add-person.ts` | `contacts` | `POST /api/contacts` | — | People / Import | **6** | Syntactic only — **no scraping** |
| C07 | Dedup / merge | `import/normalize.ts`, `pipeline.ts` | — | — | via import | — | 3, 7 | Email, then name+company, per workspace |
| C08 | Hybrid search | `search/` | `search_index`, FTS5 / tsvector | `GET /api/search` | `search` | Search | **5** | portable default; RRF k=60; degrade, don’t fail |
| C09 | Search explain / facets | `search/explain.ts` | — | same | `--explain` | Search | 5 | `matchReasons` per hit |
| C10 | Reindex / embeddings | `search/indexer.ts`, `embeddings.ts` | `search_index.embedding` JSON | job `index`/`embed` | `reindex` | — | 5, 8 | Embeddings never during import |
| C11 | Graph load + trust rules | `graph/analysis.ts`, `edges.ts` | `edges` | — | `edge` | — | **4** | Rejected never loaded; pending excluded by default |
| C12 | Communities (Louvain) | `graph/louvain.ts` | — | `GET /api/graph` | `analyze --graph` | Observatory / Network | **4** | Pure JS; caps at 50k edges |
| C13 | Degree + Brandes betweenness | `graph/centrality.ts` | — | same | same | same | **4** | Betweenness skipped > 1500 nodes |
| C14 | Connected components / avg path | `graph/` | — | same | same | same | 4 | Avg path skipped > 600 nodes |
| C15 | Warm-intro pathfinder | `graph/paths.ts`, `pathfinder.ts` | — | `GET /api/graph/path` | `path` | Pathfinder | **4** | Score `0.6×weakest + 0.4×mean hop` |
| C16 | Graph visualization payload | `graph/visualization.ts`, `position.ts` | — | `GET /api/graph/visualization` | — | Network | 4, 14 | Force-directed positions |
| C17 | Edge provenance | `graph/edges.ts`, `import-edges.ts` | `edges.source/confidence/status` | — | `edge` | — | 4 | pending / confirmed / rejected |
| C18 | Network health analytics | `analytics/` | contacts projection | `GET /api/analytics` | `analyze` | Observatory | 4, 9 | Composite score; Shannon entropy |
| C19 | Relationship scoring | `crm/scoring.ts` | `contacts.relationship_score` | — | via `track` | People | **3** | Recency 40 / freq 25 / depth 20 / richness 15 |
| C20 | Interactions | `crm/interactions.ts` | `interactions` | via timeline | `track log` | People `[id]` | 9 | Whitelisted types/channels |
| C21 | Follow-ups | `crm/follow-ups.ts` | `follow_ups` | — | `track add/done/snooze/cancel/assign` | People | 9 | Recurrence; assignment |
| C22 | Contact timeline | `crm/timeline.ts`, `contacts.ts` | — | `GET /api/contacts/:id` | — | People `[id]` | 9, 12 | |
| C23 | Contact list | `crm/contacts.ts` | — | `GET /api/contacts` | `search` | People | 9, 12 | sort recent/score/name/follow-up |
| C24 | Scan sweep | `scan/` | — | `POST /api/scan` | `scan` | Scan | 7, 11 | reindex → enrich → graph; best-effort |
| C25 | Enrichment | `enrichment/` | `enrichments` | `POST /api/enrich` | `enrich` | Settings status | 7 | Hunter/PDL/Clearbit; cache + rate limit |
| C26 | Provider status | `providers/` | — | `GET /api/providers` | `status` | Settings | 7, 17 | Honest “not configured” |
| C27 | AI outreach drafts | `ai/` | — | — | `outreach`, `path --draft` | — | **8** | Draft only; BYO key |
| C28 | Campaigns | `campaigns/` | `campaigns`, `campaign_recipients` | — | `campaign` | — | 10 | No SMTP; whitelist `{{vars}}` |
| C29 | Skills taxonomy / gap | `skills/` | `contacts.skills` JSON | — | `skills` | — | 8 | 101 skills; AI extract opt-in |
| C30 | Event attendee matching | `events/match.ts` | `events`, `event_attendees` | `GET /api/events` JSON | `events` | — | 7 | Tiers 1.0 / 0.9 / 0.6; fuzzy = review |
| C31 | Event discovery | `events/providers.ts` | — | — | — | — | later | **Stub** — do not invent scraping |
| C32 | Event recommendations | `events/` | — | — | `events recommend` | — | 7 | Overlap + stated reason |
| C33 | Content tracker | `content/` | `content_items/metrics/mentions` | — | `content` | Observatory strip | 7 | RSS + manual; 3 stubs |
| C34 | Profile cards | `card/` | `profile_cards` | — | `card` | — | 7 | HTML + vCard; draft vs published |
| C35 | Profile view analytics | `views/` | `profile_views` | — | `analyze --views` | Observatory | 7 | Daily-salted HMAC; never raw IP |
| C36 | Export | `export/` | — | — | `export` | — | 7 | CSV / JSON / vCard |
| C37 | Workspaces & roles | `workspaces/` | `workspaces`, members, invites | `--workspace` | `team` | — | 9, 15 | owner > admin > member > viewer |
| C38 | Authorship / assignment | CRM + workspaces | `created_by_user`, `assigned_to` | — | `track assign`, `team` | — | 9 | |
| C39 | Audit / activity log | `crm/activity.ts` | `activity_log` | SSE Activity page | — | Activity | 11 | |
| C40 | Key vault | `crypto/` | `key_vault` | `GET/PUT/DELETE /api/credentials` | `config` | Settings “Connect an API” | 6, 15 | AES-256-GCM; masked reads |
| C41 | Plugins | `plugins/` | `plugins` | — | `plugin` | — | **16** (late) | Disabled install; allow-lists |
| C42 | Marketplace | `plugins/marketplace.ts` | — | — | `plugin search/install` | — | 16 | Static checksummed index |
| C43 | Outbound webhooks | `webhooks.ts` | `webhooks`, `webhook_deliveries` | — | `webhook` | — | 11, 15 | HMAC + SSRF; no inbound |
| C44 | Retention purge | `retention.ts` | — | server boot job | — | — | 15 | ≤1 run / 24h; audited |
| C45 | Jobs | — | — (in-memory) | `/api/jobs*` | CLI `lib/jobs.ts` | Activity / Scan | **11** | Shared JSON shape |
| C46 | SSE event stream | — | — | `GET /api/events` | ingest | Activity | **11** | Last 200; `seq` |
| C47 | Auth (local/token/open) | — | `local.ts` auth mode | `auth/` | `token`, `serve` | serverFetch | **15** | No OAuth |
| C48 | Rate limit / headers / CORS | — | — | middleware | — | — | 15 | 600/min/IP; loopback CORS default |
| C49 | Health / server-info | search index status | migration counts | `/api/health`, `/api/server-info` | `status` | banners | 1, 12 | Public probes |
| C50 | Settings | — | config.toml | `GET/PUT /api/settings` | `config` | Settings | 12 | File-managed; PUT returns guidance |
| C51 | Docker / Postgres deploy | — | pooling, SSL mapping | bind 0.0.0.0 warned | migrate job | compose web | 1, 20 | One image, three roles |
| C52 | Calendar events JSON | `events/repository.ts` | `events` | `GET /api/events` (non-SSE) | `events list/show` | — | 7, 12 | Dual meaning of `/api/events` |

---

## Shared domain rules (must stay single-sourced)

These are the rules Phase 0 identified as **shared** — CLI, API, and UI all consume the same function. Python must keep that property.

| Rule | Function | Formula / contract |
| --- | --- | --- |
| Relationship score | `computeRelationshipScore` / `relationshipScoreColumn` | 0–100 then stored 0–1. Recency 40% (`100 − 0.5×days`), frequency 25% (15 pts / interaction in 90d), depth 20% (min/max inbound-outbound), richness 15% (25 pts × distinct types, cap 4) |
| Path ranking | `scoreIntroPath` | `0.6 × weakestTie + 0.4 × avgHopStrength`; hop = `minStrength × minConfidence`; ties by lexicographic id chain |
| Default path origin | `defaultPathOrigin` | Highest `relationshipScore`, then most recent interaction, then lowest id |
| RRF | `reciprocalRankFusion` | `Σ weight / (k + rank)`, **k = 60**; tie-break: score, arm count, best rank, id |
| Network health | `computeNetworkScore` | activity 0.35, diversity 0.30, size 0.20 (target 500), growth 0.15 (20/30d = max). Diversity target = 8 effective categories |
| Graph trust | `loadGraph` | `rejected` never loaded; default `confirmed` only; drop dangling / soft-deleted |
| Event match | `matchAttendees` | email 1.0, name 0.9, last+initial 0.6; auto-link ≥ 0.9; else `review` / `ambiguous` |
| LinkedIn URL | `parseLinkedInProfileUrl` | `https://www.linkedin.com/in/<username>` only; no scrape |
| Import dedupe | `runImport` | per-workspace email, else fullName+company |
| Campaign vars | `TEMPLATE_VARIABLES` | `firstName lastName fullName company role email headline location industry` only |
| Scan stages | `runScan` | queued 0 → discovering 15 → processing 40/70 → enriching 90 → indexing 90 → completed 100 |
| Retention | `runRetentionPurge` | views 90d, content metrics 365d (keep latest), webhook deliveries 30d; guard 24h via `activity_log` |

---

## Surface coverage (UI vs CLI)

| Surface | Has UI | CLI-only |
| --- | --- | --- |
| Observatory, Network, Search, Pathfinder, People, Activity, Scan, Import, Settings | yes | — |
| Campaigns, skills, events, content, team, plugins, webhooks, backup, migrate, edge, outreach, reindex, enrich, export, card | no | yes |

Python FastAPI (Phase 12) should expose the **existing** HTTP contract first so the current UI keeps working. New HTTP routes for CLI-only features are a product choice (v3.1), not a migration requirement.

---

## First vertical slice (plan §32)

When Phase 1–3 start coding, implement this slice end-to-end before expanding:

```text
Web UI People / Pathfinder
  → FastAPI (preserve /api/contacts, /api/graph/path)
  → Python application
  → SQLAlchemy on existing SQLite/PostgreSQL
  → Person + Relationship + scoring + graph construction + Pathfinder
```

Do **not** start with plugins, campaigns, marketplace, or a frontend rewrite.
