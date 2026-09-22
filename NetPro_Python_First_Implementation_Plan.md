# NetPro Python-First Migration & Implementation Plan

> **Goal:** Evolve NetPro into a **Python-first professional relationship intelligence platform**, while preserving the existing product capabilities, data, privacy model, and user experience.
>
> **Repository:** https://github.com/NiravRVaghasiya/NetPro
>
> **Phase status (2026-09-22):** Phase 0 complete — baseline freeze is commit `19f888c` (v3.0.2), governance docs in [`docs/python-migration/`](docs/python-migration/README.md). Phase 1 complete — [`backend/`](backend/README.md) is the Python foundation (uv, Ruff, mypy strict, pytest, FastAPI public probes, Typer CLI); no production feature has moved and the TypeScript product still ships. Decisions are recorded in [`docs/adr/`](docs/adr/README.md). Next: Phase 2 (database & persistence).

## Executive decision

Do **not** perform a big-bang rewrite.

The current NetPro repository is already a substantial TypeScript monorepo with a web UI, CLI, HTTP API, reusable core logic, SQLite/PostgreSQL support, graph analytics, search, CRM, imports, AI drafting, plugins, jobs/SSE, security controls, and extensive tests.

The migration should therefore be an **incremental strangler migration**:

```text
Current
Next.js / TypeScript
        +
TypeScript core / API / CLI
        |
        v
Phase 0: establish Python foundation
        |
        v
Python graph + intelligence
        |
        v
Python domain/application services
        |
        v
Python integrations/imports/jobs
        |
        v
Python API + CLI
        |
        v
Python-first NetPro
        |
        +---- Next.js/TypeScript UI retained initially
        |
        +---- optional Python-rendered UI later
```

### Target principle

**Python wherever Python provides a material advantage.**

Do not translate TypeScript line-for-line. Preserve behavior and contracts, but redesign implementation around Python's strengths in:

- graph analytics
- data processing
- search/ranking
- AI/ML
- NLP
- integrations
- background processing
- CLI tooling
- domain services

Keep the browser UI in TypeScript/React/Next.js initially. "Python-first" does **not** mean "force Python into the browser."

---

# 1. Target Architecture

The target architecture should be a **Python modular monolith**, not an early microservice system.

```text
                         ┌───────────────────────────┐
                         │       Next.js Web UI       │
                         │   React + TypeScript       │
                         └─────────────┬─────────────┘
                                       │
                                   HTTP / SSE
                                       │
                         ┌─────────────▼─────────────┐
                         │       FastAPI API          │
                         │      Python 3.12+          │
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │      Application Layer     │
                         │ use cases / commands /     │
                         │ queries / authorization    │
                         └─────────────┬─────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
      ┌───────▼────────┐      ┌────────▼───────┐      ┌────────▼────────┐
      │ Domain Modules  │      │ Intelligence   │      │ Integrations    │
      │                 │      │                │      │                 │
      │ People          │      │ Graph          │      │ LinkedIn        │
      │ Relationships   │      │ Search         │      │ AI Providers    │
      │ Interactions    │      │ Ranking        │      │ Enrichment      │
      │ Follow-ups      │      │ Semantic       │      │ Events          │
      │ Workspaces      │      │ Recommendations│      │ Content         │
      └───────┬─────────┘      └────────┬───────┘      └────────┬────────┘
              │                         │                       │
              └─────────────────────────┼───────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ Repository / Data │
                              │ SQLAlchemy 2      │
                              │ SQLite + Postgres │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ Alembic migrations │
                              └───────────────────┘

CLI:
Typer → Application Layer → same use cases as API/UI

Jobs:
Python worker → Application Layer → same use cases as API/CLI
```

## Recommended Python stack

Use mature, boring technologies unless the repository proves a better alternative is needed.

| Concern | Target |
|---|---|
| Python | 3.12+ |
| API | FastAPI |
| Validation | Pydantic v2 |
| ORM | SQLAlchemy 2.x |
| Migrations | Alembic |
| CLI | Typer |
| Graph | NetworkX initially; evaluate igraph later |
| Data processing | Python stdlib + pandas only where justified |
| Numerical work | NumPy / SciPy where useful |
| Search | PostgreSQL FTS + SQLite FTS5 |
| Semantic search | Provider abstraction; sentence-transformers optional |
| HTTP | httpx |
| Async | asyncio |
| Jobs | Start with asyncio/background jobs; evaluate ARQ only when required |
| Testing | pytest |
| API testing | pytest + httpx |
| Frontend | Existing Next.js/React initially |
| Formatting | Ruff |
| Type checking | mypy or pyright |
| Packaging | uv + pyproject.toml |
| Containers | Docker |
| Database | SQLite default, PostgreSQL first-class |
| Observability | Python logging + structured context |
| Documentation | Markdown + architecture decision records |

Do not introduce Redis/Celery/Kafka/Kubernetes merely because they are common. Add infrastructure only when the workload requires it.

---

# 2. Non-Negotiable Migration Principles

## 2.1 Preserve behavior

Migration must not silently change:

- relationship scoring
- search semantics
- graph algorithms
- import behavior
- deduplication
- workspace isolation
- authentication/authorization
- credential handling
- retention
- backup/restore
- API contracts
- CLI behavior

Where behavior changes intentionally, document it.

## 2.2 One business rule, one implementation

Avoid:

```text
Web logic
API logic
CLI logic
Python logic
```

all implementing the same rule.

Use:

```text
UI
 ↓
API / CLI
 ↓
Application use case
 ↓
Domain
 ↓
Repository
```

## 2.3 Contract-first migration

For every migrated capability:

1. Define the behavior.
2. Capture the current behavior with tests.
3. Define a Python interface.
4. Implement Python.
5. Run old and new implementations against the same fixtures where practical.
6. Compare results.
7. Switch the consumer.
8. Remove the old implementation only after verification.

## 2.4 No premature microservices

Python-first does not require multiple Python services.

Start with:

```text
netpro/
  api/
  application/
  domain/
  intelligence/
  integrations/
  infrastructure/
  cli/
```

Split services only when there is a demonstrated operational reason.

---

# 3. Phase 0 — Baseline and Migration Governance

**Objective:** Establish a trustworthy baseline before changing implementation.

### Tasks

- Freeze a known-good baseline commit.
- Run the complete existing test suite.
- Record test counts and failures.
- Record build/typecheck/lint results.
- Capture representative database fixtures.
- Export representative API responses.
- Capture CLI output for important commands.
- Document current architecture.
- Inventory all TypeScript packages/apps.
- Map each capability to its current implementation.
- Identify shared domain rules.
- Identify database access patterns.
- Identify external integrations.
- Identify security-sensitive code.
- Identify background jobs/SSE behavior.
- Identify existing plugin boundaries.

### Deliverables

Create:

```text
docs/python-migration/
  00-baseline.md
  capability-matrix.md
  api-contracts.md
  data-model.md
  migration-rules.md
```

### Exit criteria

- Existing test suite passes.
- Current build is reproducible.
- Every major capability has an owner/package identified.
- Migration risks are documented.

---

# 4. Phase 1 — Python Foundation

**Objective:** Introduce Python without changing user-visible behavior.

### Create

```text
backend/
  pyproject.toml
  src/
    netpro/
      __init__.py
      config/
      domain/
      application/
      intelligence/
      integrations/
      infrastructure/
      api/
      cli/
      jobs/
  tests/
```

Prefer a `src/` layout.

### Configure

- Python 3.12+
- uv
- Ruff
- pytest
- Pydantic
- SQLAlchemy
- Alembic
- FastAPI
- Typer
- httpx

### Establish conventions

- dependency injection
- typed interfaces
- async boundaries where useful
- structured errors
- configuration management
- logging
- repository pattern only where it provides value
- transaction boundaries
- timezone policy
- ID policy
- pagination conventions
- API error format

### Exit criteria

Python project installs cleanly.

Example:

```bash
uv sync
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

No production feature needs to be migrated yet.

---

# 5. Phase 2 — Database & Persistence Layer

**Objective:** Give Python a safe, tested path to the existing data model.

### Tasks

- Map existing schema.
- Identify tables/entities.
- Create SQLAlchemy models.
- Create typed domain representations where ORM objects should not leak upward.
- Configure SQLite.
- Configure PostgreSQL.
- Establish transaction handling.
- Establish connection lifecycle.
- Port migration logic to Alembic.
- Verify existing databases can be opened/read.
- Verify PostgreSQL behavior.
- Preserve indexes and constraints.
- Preserve FTS/search indexes where applicable.
- Preserve timestamps and timezone semantics.

### Important rule

Do not redesign the database merely because Python is being introduced.

First achieve:

```text
Existing DB
   ↓
Python SQLAlchemy
   ↓
Same data
```

Then optimize the schema later if justified.

### Exit criteria

Python can:

- initialize a new database
- connect to existing SQLite
- connect to PostgreSQL
- read/write core entities
- run migrations
- pass persistence tests

---

# 6. Phase 3 — Domain Model

**Objective:** Move NetPro's business concepts into Python.

Prioritize:

```text
Person
Relationship
Interaction
FollowUp
Workspace
Tag
Skill
Event
Content
Campaign
Credential
```

Create domain services for rules such as:

- relationship score
- dormancy
- interaction recording
- follow-up lifecycle
- duplicate identity
- workspace ownership
- relationship state

### Relationship scoring

Preserve the current documented formula exactly during migration.

Create golden tests:

```text
input interactions
        ↓
expected score
```

The TypeScript implementation and Python implementation should produce equivalent results before the Python version becomes authoritative.

### Exit criteria

Core domain rules can execute without importing FastAPI or frontend code.

---

# 7. Phase 4 — Graph Intelligence

**Objective:** Make Python the authoritative implementation for network intelligence.

This should be the first major Python migration because Python's graph/data ecosystem is a natural fit.

### Migrate

- graph construction
- connected components
- degree centrality
- Brandes betweenness
- Louvain communities
- average path length
- BFS/pathfinding
- relationship-weighted path ranking
- edge provenance
- inferred edge status
- network health metrics

### Suggested structure

```text
netpro/intelligence/graph/
  __init__.py
  builder.py
  models.py
  communities.py
  centrality.py
  components.py
  paths.py
  metrics.py
  provenance.py
```

### Critical requirement

Create deterministic graph fixtures.

Example:

```text
A ─ B ─ C
    │
    D
```

Test:

- expected communities
- centrality
- paths
- ranking
- inferred-edge exclusion
- provenance

### Performance

Benchmark:

- 1k contacts
- 10k contacts
- 50k contacts
- 100k contacts where practical

Do not optimize prematurely.

### Exit criteria

Python produces equivalent or intentionally improved graph results.

The API/UI can consume Python graph results.

---

# 8. Phase 5 — Search & Ranking

**Objective:** Move search intelligence to Python.

Preserve the existing search model:

```text
substring
    +
full-text
    +
optional semantic
    ↓
RRF fusion
    ↓
filters
    ↓
ranking
```

### Implement

```text
netpro/intelligence/search/
  lexical.py
  fulltext.py
  semantic.py
  fusion.py
  filters.py
  ranking.py
  explain.py
```

### Important

Search should degrade gracefully:

```text
No embedding provider
→ lexical/full-text search

Embedding provider unavailable
→ lexical/full-text search + explicit reason

No FTS index
→ substring search
```

### Preserve explainability

Results should continue to explain:

- matched name
- company
- role
- notes
- tags
- skills
- semantic similarity where available
- community/filter match

### Exit criteria

Search results match the baseline fixtures.

---

# 9. Phase 6 — LinkedIn URL & Import Experience

**Objective:** Make importing a person/data source dramatically easier.

This phase incorporates the new UX requirement.

### LinkedIn URL

Support a simple flow:

```text
Add Person
   ↓
Paste LinkedIn URL
   ↓
Validate
   ↓
Check duplicate
   ↓
Import/enrich if supported
   ↓
Person created
```

Support normalized profile URLs such as:

```text
https://www.linkedin.com/in/username
https://linkedin.com/in/username/
```

Do not invent unsupported scraping behavior.

### API key

Create a simple provider flow:

```text
Provider
API Key
[ Validate & Save ]
```

Use existing secure credential storage.

Never:

- log keys
- return raw keys
- store keys in browser localStorage
- place keys in URLs

### Migration

Move LinkedIn URL validation and provider credential business rules into Python.

### Exit criteria

A new user can add a LinkedIn profile with minimal friction and configure a provider without understanding the underlying architecture.

---

# 10. Phase 7 — Imports, Enrichment & Integrations

**Objective:** Move data ingestion and external providers into Python.

### Migrate

- LinkedIn CSV import
- CSV validation
- deduplication/merge
- backup/restore
- enrichment providers
- event imports
- content imports
- RSS
- AI provider clients
- embedding providers

### Integration architecture

Use explicit provider interfaces:

```python
class EnrichmentProvider(Protocol):
    async def enrich_person(...) -> EnrichmentResult:
        ...
```

Then:

```text
integrations/
  ai/
  enrichment/
  linkedin/
  events/
  content/
  embeddings/
```

Do not allow provider-specific logic to leak into domain code.

### Exit criteria

Integrations are independently testable and provider failures degrade gracefully.

---

# 11. Phase 8 — AI & Semantic Intelligence

**Objective:** Make Python the intelligence layer for AI/ML capabilities.

### Migrate

- outreach drafting orchestration
- prompt construction
- provider abstraction
- semantic embeddings
- skill extraction
- recommendations
- event matching where ML is beneficial
- entity resolution where appropriate

### Provider model

```text
AI interface
   ├── OpenAI-compatible
   └── Anthropic
```

The core should depend on an abstraction, not a vendor SDK.

### Security

Provider keys remain outside domain logic.

### AI principle

AI should enhance NetPro but never silently replace deterministic logic where explainability matters.

For example:

```text
Skill taxonomy
   ↓
Deterministic matching
   ↓
Optional AI assistance
```

not:

```text
LLM decides everything
```

---

# 12. Phase 9 — CRM & Relationship Operations

**Objective:** Move the operational relationship layer into Python.

### Migrate

- interaction history
- relationship score calculation
- timeline
- follow-ups
- reminders
- recurrence
- assignment
- dormancy detection
- reconnect recommendations

### Application services

Example:

```text
record_interaction()
complete_followup()
snooze_followup()
calculate_relationship_score()
find_dormant_relationships()
recommend_reconnections()
```

### Exit criteria

CLI/API/UI can all invoke the same Python application use cases.

---

# 13. Phase 10 — Campaigns & Outreach

**Objective:** Move outreach orchestration into Python while preserving the human-controlled model.

### Migrate

- campaign lifecycle
- recipient snapshots
- merge variables
- drip steps
- delays
- per-day limits
- interaction logging
- reply cancellation

### Critical safety rule

NetPro remains:

> **Draft first; human sends.**

Do not introduce automatic outbound sending during migration.

---

# 14. Phase 11 — Background Jobs & SSE

**Objective:** Replace TypeScript job execution with Python.

Start simple.

### First implementation

Use:

```text
FastAPI
+
asyncio
+
database-backed job state
+
SSE
```

Only introduce Redis/ARQ if actual workload requires it.

### Job model

```text
queued
  ↓
running
  ↓
completed

queued
  ↓
running
  ↓
failed
```

Every job should have:

- ID
- type
- workspace
- created_at
- started_at
- completed_at
- status
- progress
- error
- result reference

### SSE

Preserve existing event semantics so the web UI does not need to know that execution moved from TypeScript to Python.

---

# 15. Phase 12 — FastAPI API

**Objective:** Make Python the authoritative HTTP API.

### API structure

```text
api/
  app.py
  dependencies.py
  errors.py

  routes/
    people.py
    relationships.py
    interactions.py
    search.py
    graph.py
    pathfinder.py
    followups.py
    imports.py
    integrations.py
    campaigns.py
    events.py
    content.py
    skills.py
    jobs.py
    settings.py
```

### Principles

- Pydantic request/response models
- typed responses
- workspace authorization
- consistent errors
- pagination
- filtering
- idempotency where necessary
- rate limits where appropriate
- no business logic inside route handlers

Route handlers should be thin:

```text
HTTP
 ↓
dependency/auth
 ↓
application use case
 ↓
domain
 ↓
repository
```

### Exit criteria

The existing web UI can operate primarily against the Python API.

---

# 16. Phase 13 — Python CLI

**Objective:** Make Python the authoritative CLI.

Use Typer.

Example:

```bash
netpro init
netpro serve
netpro people list
netpro people add
netpro people import
netpro search
netpro graph analyze
netpro pathfinder
netpro followups
netpro backup
netpro restore
```

Do not create CLI-specific business logic.

Use:

```text
Typer
  ↓
Application service
```

The CLI and API must produce consistent results.

---

# 17. Phase 14 — Web UI Integration

**Objective:** Keep the existing Next.js UI while replacing its backend implementation.

This is intentionally a TypeScript phase.

Do not rewrite the UI at the same time as the backend.

### Migration

```text
Next.js
   ↓
FastAPI
   ↓
Python core
```

Remove direct dependencies on TypeScript domain/core logic gradually.

### API compatibility

Where possible, preserve API shapes.

If breaking changes are necessary:

```text
/api/v1
/api/v2
```

or provide a compatibility layer.

### Exit criteria

The web UI can run with the Python backend without TypeScript business logic.

---

# 18. Phase 15 — Authentication, Authorization & Security

**Objective:** Revalidate security after migration.

Audit:

- authentication
- workspace isolation
- authorization
- CSRF where applicable
- CORS
- SSRF protection
- credential encryption
- secret redaction
- audit logs
- rate limiting
- webhook signatures
- retention
- file uploads
- URL fetching
- plugin network restrictions

### Credential rule

Python must never accidentally make credentials easier to expose.

Add automated tests asserting that:

```text
API response ≠ raw credential
logs ≠ raw credential
exceptions ≠ raw credential
database plaintext ≠ credential
```

---

# 19. Phase 16 — Plugin Architecture

**Objective:** Port the plugin system after the core platform is stable.

Do not migrate plugins before the Python extension boundary is mature.

### Design

```text
Plugin manifest
      ↓
Capability validation
      ↓
Sandbox/policy checks
      ↓
Plugin adapter
      ↓
NetPro application interfaces
```

Preserve:

- allow-lists
- capability restrictions
- host restrictions
- disabled-by-default behavior
- verification model
- provenance
- security boundaries

Plugins must not receive unrestricted application internals.

---

# 20. Phase 17 — Remove TypeScript Backend/Core

Only begin this phase after all Python replacements are production-equivalent.

### Checklist

- Python API authoritative
- Python CLI authoritative
- Python graph engine authoritative
- Python search authoritative
- Python domain authoritative
- Python integrations authoritative
- Python jobs authoritative
- UI no longer imports TypeScript business logic
- all tests pass
- migration fixtures pass
- performance benchmarks pass
- security audit complete

Then remove:

- obsolete TypeScript core modules
- duplicate repositories
- duplicate business rules
- duplicate job implementations
- duplicate API handlers

Do this incrementally.

Do not delete the old implementation until the replacement has been stable.

---

# 21. Phase 18 — Optional Python-Rendered UI

This is **optional**, not part of the core migration.

After the Python backend is stable, decide whether the project actually benefits from replacing Next.js.

Possible choices:

### Option A — Keep Next.js

Recommended.

```text
Next.js
+
FastAPI
```

Best if the UI remains highly interactive and graph-heavy.

### Option B — HTMX + Jinja

Consider if the priority becomes:

- simpler deployment
- fewer frontend dependencies
- server-rendered UI
- Python-only application

### Option C — React frontend remains TypeScript

This is still a Python-first architecture.

"Python-first" does not require every file in the repository to be Python.

Do not undertake this migration unless there is a demonstrated product/maintenance benefit.

---

# 22. Phase 19 — Performance & Scale

After functional parity:

Benchmark:

- startup
- API latency
- search
- graph construction
- Pathfinder
- imports
- bulk imports
- semantic search
- job throughput
- database operations

Test:

```text
1,000 contacts
10,000 contacts
50,000 contacts
100,000 contacts
```

where realistic.

Optimize only measured bottlenecks.

Potential optimizations:

- SQL query tuning
- indexes
- batching
- caching
- incremental graph construction
- background computation
- NetworkX → igraph for large graphs if justified
- PostgreSQL-specific optimizations

Do not prematurely introduce distributed infrastructure.

---

# 23. Phase 20 — Documentation & Developer Experience

Create authoritative docs:

```text
docs/
  architecture/
    overview.md
    domain.md
    intelligence.md
    integrations.md
    jobs.md
    security.md

  development/
    setup.md
    testing.md
    database.md
    migrations.md

  api/
    overview.md

  migration/
    python-first.md
```

Add ADRs for major decisions:

```text
docs/adr/
  001-python-first.md
  002-fastapi.md
  003-sqlalchemy.md
  004-graph-engine.md
  005-background-jobs.md
  006-frontend-boundary.md
```

---

# 24. Testing Strategy

Testing is a migration safety mechanism, not a final step.

## Unit tests

Test:

- domain rules
- scoring
- validation
- graph algorithms
- ranking
- URL normalization
- provider adapters

## Integration tests

Test:

- SQLite
- PostgreSQL
- migrations
- repositories
- API
- jobs
- integrations

## Contract tests

Run identical fixtures against:

```text
old implementation
new Python implementation
```

during migration.

Compare:

- IDs where deterministic
- scores
- search ranking
- graph metrics
- API shapes
- error behavior

## End-to-end tests

Test:

```text
Import
 → Search
 → Person
 → Relationship
 → Pathfinder
 → Follow-up
 → AI draft
```

as one coherent user workflow.

---

# 25. Data Migration Strategy

Do not require users to recreate their NetPro databases.

Support:

```text
Existing SQLite DB
        ↓
Python SQLAlchemy
        ↓
Existing data preserved
```

For PostgreSQL:

```text
Existing PostgreSQL
        ↓
Python application
        ↓
Existing data preserved
```

If schema migration is required:

1. backup
2. migration
3. validation
4. application start
5. post-migration verification

Provide:

```bash
netpro doctor
```

that reports:

- database connectivity
- schema version
- migration state
- credential configuration
- search index state
- optional provider status

---

# 26. Observability

Create a consistent Python logging model.

Every request/job should have:

- request ID
- workspace ID where safe
- operation
- duration
- outcome

Never log:

- API keys
- access tokens
- raw credentials
- unnecessary personal data

Add metrics only where useful.

---

# 27. CI/CD

Create Python CI alongside existing CI.

Minimum:

```text
Python versions
   ↓
ruff
   ↓
typecheck
   ↓
unit tests
   ↓
integration tests
   ↓
PostgreSQL tests
   ↓
build/package
```

During migration:

```text
TypeScript CI
+
Python CI
```

Only remove TypeScript CI after TypeScript backend/core is retired.

---

# 28. Recommended Repository End State

Target:

```text
NetPro/
├── apps/
│   └── web/                     # Next.js UI initially
│
├── backend/
│   ├── pyproject.toml
│   ├── src/
│   │   └── netpro/
│   │       ├── api/
│   │       ├── application/
│   │       ├── cli/
│   │       ├── config/
│   │       ├── domain/
│   │       ├── infrastructure/
│   │       ├── intelligence/
│   │       ├── integrations/
│   │       └── jobs/
│   │
│   └── tests/
│
├── docs/
│   ├── architecture/
│   ├── development/
│   ├── migration/
│   └── adr/
│
├── plugins/
│
├── marketplace/
│
├── docker/
│
├── scripts/
│
├── README.md
├── docker-compose.yml
└── LICENSE
```

Eventually, if the web application remains separate:

```text
apps/web
backend/
```

is a perfectly acceptable final architecture.

---

# 29. Recommended Migration Order

The actual implementation order should be:

```text
PHASE 0
Baseline
   ↓
PHASE 1
Python foundation
   ↓
PHASE 2
Database
   ↓
PHASE 3
Domain model
   ↓
PHASE 4
Graph intelligence        ← high priority
   ↓
PHASE 5
Search & ranking          ← high priority
   ↓
PHASE 6
LinkedIn + API-key UX    ← high priority
   ↓
PHASE 7
Imports/integrations
   ↓
PHASE 8
AI/semantic intelligence
   ↓
PHASE 9
CRM/relationships
   ↓
PHASE 10
Campaigns/outreach
   ↓
PHASE 11
Jobs/SSE
   ↓
PHASE 12
FastAPI
   ↓
PHASE 13
Python CLI
   ↓
PHASE 14
Next.js → Python API
   ↓
PHASE 15
Security hardening
   ↓
PHASE 16
Plugins
   ↓
PHASE 17
Remove TS backend/core
   ↓
PHASE 18
Optional Python UI
   ↓
PHASE 19
Performance
   ↓
PHASE 20
Documentation / release
```

---

# 30. What NOT to Migrate First

Avoid starting with:

- frontend rewrite
- plugin marketplace
- campaigns
- content tracker
- event recommendation
- authentication rewrite
- deployment rewrite
- microservices
- Redis
- Kubernetes

These create large migration surface areas without proving the Python architecture.

Start with the parts where Python is clearly stronger:

**graph → search → intelligence → domain → integrations**

---

# 31. Definition of "Python-First NetPro"

The migration is successful when:

### Architecture

- Python owns domain logic.
- Python owns intelligence.
- Python owns integrations.
- Python owns API.
- Python owns CLI.
- Python owns background jobs.
- TypeScript is primarily the browser UI.

### Product

The user cannot tell which language implements the backend.

### Engineering

There is one authoritative implementation of each business rule.

### Data

Existing SQLite/PostgreSQL data remains usable.

### Security

The existing security posture is preserved or improved.

### Performance

Python meets or exceeds acceptable performance for real-world network sizes.

### Developer experience

A contributor can run:

```bash
uv sync
uv run pytest
uv run netpro serve
```

and understand the Python application without needing to understand the old TypeScript backend.

---

# 32. First 10 Implementation Tasks

Do these before attempting the larger migration:

1. Add `backend/` Python project using `uv`.
2. Configure Ruff + pytest + type checking.
3. Add a Python health endpoint.
4. Connect Python to an existing NetPro SQLite database.
5. Implement one SQLAlchemy read path for `Person`.
6. Implement one domain service for relationship scoring.
7. Port graph construction and Pathfinder.
8. Build golden tests comparing TypeScript vs Python graph results.
9. Port search/ranking with golden fixtures.
10. Put the Python API behind the existing web UI for one vertical slice.

The first vertical slice should be:

```text
Web UI
  ↓
FastAPI
  ↓
Python application
  ↓
SQLAlchemy
  ↓
Existing SQLite/PostgreSQL
  ↓
Person + Relationship
```

Then expand from that slice rather than building an entire Python platform in isolation.

---

# 33. First Milestone

The first meaningful milestone should be:

## "NetPro Python Core"

It should provide:

- Python project
- database connectivity
- Person domain
- Relationship domain
- relationship scoring
- graph construction
- Pathfinder
- search
- tests
- FastAPI skeleton
- CLI skeleton

At that point the repository has a real Python foundation without requiring a complete rewrite.

---

# 34. Final Strategic Recommendation

Do not make the goal:

> "Rewrite NetPro from TypeScript to Python."

Make the goal:

> **"Make Python the authoritative implementation of NetPro's domain and intelligence platform while preserving the existing product."**

That distinction matters.

The strongest final architecture is likely:

```text
                NETPRO
                   │
        ┌──────────┴──────────┐
        │                     │
   Web Experience        Python Platform
   Next.js/React          FastAPI
                         Domain
                         Graph
                         Search
                         AI
                         Integrations
                         Jobs
                         CLI
                              │
                       SQLite / PostgreSQL
```

This gives NetPro a Python-first foundation without sacrificing the quality of the existing web experience.

## Success metric

The migration is complete when a new feature can be implemented like this:

```text
New capability
      ↓
Python domain/application layer
      ↓
Python API
      ↓
CLI + Web UI consume it
```

rather than:

```text
New capability
      ↓
TypeScript implementation
      ↓
duplicate Python implementation
      ↓
duplicate UI logic
```

**One domain. One implementation. Many interfaces.**

That should be the architectural north star for Python-first NetPro.
