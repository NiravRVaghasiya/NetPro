# Migration rules

Governance for the strangler migration. If a later phase conflicts with this file, **this file wins** until an ADR updates it.

Parent plan: [NetPro_Python_First_Implementation_Plan.md](../../NetPro_Python_First_Implementation_Plan.md).

---

## 1. Goal

> Make Python the authoritative implementation of NetPro's domain and intelligence platform while preserving the existing product.

Not: “rewrite NetPro from TypeScript to Python.”

Target:

```text
Next.js / React  (UI, kept initially)
        ↓ HTTP / SSE
FastAPI + Python domain / graph / search / jobs / CLI
        ↓
Existing SQLite / PostgreSQL
```

---

## 2. Non-negotiable behaviour

Migration must not silently change:

| Area | Freeze reference |
| --- | --- |
| Relationship scoring | `crm/scoring.ts` — weights and 0–1 column |
| Search semantics | portable default; RRF k=60; degradation reasons |
| Graph algorithms | Louvain, Brandes, path score 0.6/0.4; pending excluded |
| Import / dedup | LinkedIn CSV preamble skip; email then name+company; per workspace |
| LinkedIn URL | syntactic only; canonical `https://www.linkedin.com/in/<slug>` |
| Workspace isolation | every query scoped; default workspace `default` |
| Auth | local / token / open; no OAuth |
| Credentials | never log, never return raw keys, never store in localStorage/URLs |
| Retention | 90 / 365 / 30 day windows; 24h guard |
| Backup / restore | existing files remain restorable |
| API contracts | [api-contracts.md](api-contracts.md) |
| CLI `--json` | same payloads as HTTP |
| Human-controlled outreach | **no SMTP**, no stored mailbox, no background send |

Intentional behaviour changes require an ADR under `docs/adr/` and a README note.

---

## 3. One business rule, one implementation

Forbidden:

```text
Web logic + API logic + CLI logic + Python logic
```

Required:

```text
UI  →  API / CLI  →  application use case  →  domain  →  repository
```

TypeScript `@netpro/core` remains authoritative until the Python module has **golden-test parity** and the consumer has been switched. Then delete the TS module. Do not run two scoring functions in production.

---

## 4. Contract-first loop (every capability)

1. Define behaviour (this folder + the TS source).
2. Capture current behaviour with tests / fixtures.
3. Define a Python interface.
4. Implement Python.
5. Run old and new against the same fixtures.
6. Compare results (scores, ranks, graph metrics, API JSON).
7. Switch the consumer (server route or CLI).
8. Remove the old implementation only after verification.

Golden fixtures already started:

- [`fixtures/data/graph-golden.md`](fixtures/data/graph-golden.md)
- [`fixtures/data/linkedin-connections.sample.csv`](fixtures/data/linkedin-connections.sample.csv)
- [`fixtures/api/*.json`](fixtures/api/)

---

## 5. What not to do first

Do **not** start with:

- Frontend rewrite
- Plugin marketplace
- Campaigns / content tracker / event recommendation
- Authentication rewrite
- Deployment rewrite
- Microservices, Redis, Kafka, Kubernetes
- Schema redesign
- “Helpful” SMTP
- LinkedIn scraping
- Dropping Auth.js leftover tables
- Changing job/SSE event names

Start where Python is stronger: **graph → search → intelligence → domain → integrations**.

---

## 6. Recommended order (do not skip)

```text
0 Baseline          ← this folder (done)
1 Python foundation (uv, Ruff, pytest, empty src layout)
2 Database          SQLAlchemy + Alembic on existing schema
3 Domain            Person, Relationship, scoring
4 Graph             first major Python win
5 Search            RRF + degrade
6 LinkedIn + keys   UX already in TS; port rules
7 Imports / providers
8 AI / semantic
9 CRM operations
10 Campaigns
11 Jobs / SSE
12 FastAPI          UI talks to Python
13 Python CLI
14 Next.js retarget
15 Security audit
16 Plugins          late on purpose
17 Remove TS core
18 Optional Python UI   (probably keep Next.js)
19 Performance
20 Docs / ADRs / release
```

Phase 1 must still leave the TypeScript product fully runnable.

---

## 7. Python stack (boring on purpose)

| Concern | Choice |
| --- | --- |
| Python | 3.12+ |
| Packaging | uv + `backend/pyproject.toml`, src layout |
| API | FastAPI + Pydantic v2 |
| ORM | SQLAlchemy 2 |
| Migrations | Alembic (must open existing DBs) |
| CLI | Typer |
| Graph | NetworkX first; igraph only if measured |
| HTTP | httpx |
| Tests | pytest |
| Lint | Ruff |
| Types | mypy or pyright |
| Jobs | asyncio + DB/in-memory first; no Redis until required |

Layout:

```text
backend/
  pyproject.toml
  src/netpro/{api,application,cli,config,domain,infrastructure,intelligence,integrations,jobs}
  tests/
```

---

## 8. Data compatibility

Users must not recreate databases.

- Existing `~/.netpro/netpro.db` opens read/write.
- Existing PostgreSQL with 15 migrations applied opens read/write.
- If Alembic needs a baseline revision, stamp `0014_webhooks` as the current head without rewriting SQL.
- `netpro doctor` (new, later) should report dialect, schema version, providers — do not block Phase 1 on it.

IDs stay UUID strings. Timestamps stay ISO-8601 text until an ADR says otherwise (changing to `timestamptz` is a **behavioural** migration, not a free cleanup).

---

## 9. Testing during migration

| Layer | What |
| --- | --- |
| Unit | scoring, RRF, URL parse, path score, event match, vault encrypt/decrypt |
| Integration | SQLite + Postgres; migrations apply twice |
| Contract | identical fixtures vs TS (scores, ranks, API JSON, 401 body) |
| Security | API/logs/exceptions ≠ raw credential; SSRF private ranges refused |
| E2E | Import → Search → Person → Pathfinder → Follow-up → draft |

Do not mock SQL. Use scratch SQLite files (the TS suite already does).

Performance budgets already exist as tests (`packages/core/src/perf.budget.test.ts`, graph 3k nodes / 8k edges). Python must meet them before declaring Phase 4/5 done; optimize only measured bottlenecks (Phase 19).

---

## 10. Security rules (Python must not weaken)

1. Default bind `127.0.0.1`. Binding `0.0.0.0` warns and requires a token in `local` mode.
2. Three auth modes only. Presence of `X-Forwarded-For` / `X-Real-Ip` / `Forwarded` **revokes** loopback trust.
3. Token compare is hashed + constant-time.
4. Vault: AES-256-GCM, principal-bound derivation, masked list, 503 if master missing on write.
5. Webhooks: HMAC `t=<unix>,v1=<hmac>`, 5-minute tolerance; refuse RFC1918 / loopback / link-local / metadata; re-check every redirect hop (max 3, 10s). Escape hatch `NETPRO_WEBHOOKS_ALLOW_PRIVATE=1` only.
6. Plugins: install disabled; capability + host allow-lists; no unrestricted internals; tarball extraction hardened.
7. Profile views: never store raw IPs.
8. Rate limit on by default (600/min/IP).
9. CORS: authenticated + allow-listed origin; no `*`.
10. Campaigns never send mail.

Automated tests that Python responses/logs/exceptions do not contain raw keys should land as soon as credentials exist (do not wait for Phase 15).

---

## 11. Plugin boundary (port late)

Keep the TypeScript plugin runtime until the Python application interfaces are stable (plan Phase 16). Until then:

- Do not load TS plugins from Python.
- Do not invent a second manifest format.
- The example plugin (`plugins/example-event-discovery`) and `marketplace/index.json` stay as-is.

---

## 12. Jobs & SSE

Preserve:

- Job types, statuses, 0–100 progress, camel+snake timestamps
- SSE event **names** in `EVENT_TYPES`
- Dual meaning of `GET /api/events` (Accept header)
- `POST /api/events/ingest` for CLI bridging until the CLI itself is Python

Persistence is optional. Changing event names is not.

---

## 13. Web UI

Keep Next.js until Phase 14. The UI already talks HTTP+SSE only (`apps/web/lib/netpro-server.ts`). Point `NETPRO_SERVER_URL` at FastAPI when the contract matches.

Do not import `@netpro/core` from `apps/web` (it already doesn’t). Do not add React business logic during the port.

---

## 14. CI

During migration:

```text
TypeScript CI (existing ci.yml)
+ Python CI (ruff, typecheck, pytest, later Postgres)
```

Remove TypeScript backend CI only after Phase 17. Never let Python CI be the only gate while `netpro` still ships the TS CLI tarball.

---

## 15. ADRs required before (or with) the decision

Create under `docs/adr/` when the decision is made, not before:

| ID | Decision |
| --- | --- |
| 001 | Python-first (strangler, not big-bang) |
| 002 | FastAPI |
| 003 | SQLAlchemy 2 + Alembic stamped on existing migrations |
| 004 | Graph engine (NetworkX vs igraph) |
| 005 | Background jobs (in-memory vs DB vs ARQ) |
| 006 | Frontend boundary (keep Next.js) |

Phase 0 does not create these files; Phase 1’s first commit should add **001**.

---

## 16. Definition of done for “Python-first NetPro”

- Python owns domain, intelligence, integrations, API, CLI, jobs.
- TypeScript is primarily the browser UI.
- Existing SQLite/PostgreSQL data still works.
- Security posture preserved or stricter.
- A contributor can `uv sync && uv run pytest && uv run netpro serve` without understanding the old TS backend.
- A new feature is implemented once in Python and consumed by CLI + UI.

Until then, v3.0.2 TypeScript remains the shipped product.

---

## 17. First 10 implementation tasks (Phase 1+)

1. Add `backend/` with uv.
2. Ruff + pytest + type checking.
3. Python health endpoint (can sit beside TS during strangler).
4. Connect to an existing NetPro SQLite file.
5. One SQLAlchemy read path for Person.
6. Domain service for relationship scoring + golden tests vs TS.
7. Graph construction + Pathfinder.
8. Golden tests TS vs Python on [`graph-golden.md`](fixtures/data/graph-golden.md).
9. Search/ranking with golden fixtures.
10. One vertical slice: UI → FastAPI → Person + Relationship.

Do not expand the slice into a platform-in-isolation.
