# NetPro — Vercel Removal & Local-First Web UI Implementation Plan

## Goal

Remove Vercel and the Vercel deployment model completely.

NetPro should become a **local-first, self-hostable application** where:

- The CLI performs imports, scanning, enrichment, search, analytics, graph processing, and other operations.
- A local NetPro server exposes the application API.
- The Web UI visualizes and controls NetPro through that local server.
- SQLite is the default local database.
- PostgreSQL remains supported for self-hosted/server deployments.
- The Web UI contains no business logic that duplicates `packages/core`.
- GitHub OAuth is **not required** for local use.
- Vercel is removed entirely from source, configuration, documentation, CI, and deployment assumptions.

Target architecture:

```text
                    ┌──────────────────────┐
                    │     packages/core    │
                    │ Domain + business     │
                    │ logic + search + graph│
                    └──────────┬───────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
        ┌────────▼────────┐        ┌─────────▼─────────┐
        │    apps/cli     │        │  packages/server  │
        │                  │        │                   │
        │ Commands/import  │        │ HTTP/API/jobs/SSE │
        │ scan/search/etc. │        │ auth/config       │
        └────────┬─────────┘        └─────────┬─────────┘
                 │                            │
                 │                            │
                 │                    ┌───────▼────────┐
                 │                    │    apps/web    │
                 │                    │                 │
                 │                    │ Observatory UI  │
                 │                    │ Graph/Search    │
                 │                    │ Activity/Scan   │
                 │                    └─────────────────┘
                 │
          ┌──────▼───────┐
          │ SQLite / PG  │
          └──────────────┘
```

Dependency rule:

```text
packages/core
      ↓
CLI / Server
      ↓
Web UI
```

The Web UI must never become the application's business-logic layer again.

---

# Phase 0 — Freeze the Current System

## Objective

Create a known-good baseline before changing architecture.

## Tasks

- Create a dedicated branch:

```bash
git checkout -b refactor/local-first-web
```

- Record current package structure.
- Record all Vercel-specific files and references.
- Run the existing test suite.
- Run lint.
- Run typecheck.
- Run build.
- Run PostgreSQL tests.
- Verify existing CLI commands.
- Verify existing Web UI.
- Document known failures before beginning the migration.

## Inventory

Search the repository for:

```bash
grep -Rni "vercel" . --exclude-dir=node_modules --exclude-dir=.git
grep -Rni "nextauth" . --exclude-dir=node_modules --exclude-dir=.git
grep -Rni "NEXTAUTH" . --exclude-dir=node_modules --exclude-dir=.git
grep -Rni "AUTH_URL" . --exclude-dir=node_modules --exclude-dir=.git
grep -Rni "VERCEL" . --exclude-dir=node_modules --exclude-dir=.git
```

Also inspect:

```text
apps/web/
apps/cli/
packages/core/
packages/db/
scripts/
.github/
vercel.json
.env.example
package.json
turbo.json
```

## Exit criteria

- Existing tests pass or known failures are documented.
- All Vercel dependencies are inventoried.
- No architectural changes are mixed into this baseline phase.

---

# Phase 1 — Separate Server From Web UI

## Objective

Stop treating Next.js as the application's backend.

Create:

```text
packages/server/
```

Responsibilities:

- HTTP server
- REST/API routes
- authentication
- job management
- SSE event streaming
- configuration
- server lifecycle
- database access through existing DB/core layers

The Web UI becomes a client.

## Proposed structure

```text
packages/server/
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config.ts
│   ├── routes/
│   ├── middleware/
│   ├── jobs/
│   ├── events/
│   ├── auth/
│   └── server.ts
└── package.json
```

Do not move business logic into this package.

Business rules remain in:

```text
packages/core/
```

## Exit criteria

- Server package builds independently.
- Server can import `packages/core`.
- Server does not depend on Vercel APIs.
- Server does not require the Web UI.

---

# Phase 2 — Implement `netpro serve`

## Objective

Make NetPro runnable entirely on the user's machine.

Add:

```bash
netpro serve
```

Default behavior:

```text
Host: 127.0.0.1
Port: 3777
```

Example:

```bash
netpro serve
```

Output:

```text
NetPro server started

Local: http://127.0.0.1:3777
Database: ~/.netpro/netpro.db

Web UI: http://127.0.0.1:3777
```

## CLI/server relationship

The CLI should be able to start or communicate with the local server.

Potential commands:

```bash
netpro init
netpro serve
netpro status
netpro config
```

## Security requirement

Default binding must be:

```text
127.0.0.1
```

Do not bind to:

```text
0.0.0.0
```

unless the user explicitly configures remote access.

## Exit criteria

```bash
netpro serve
```

starts successfully without Vercel, cloud infrastructure, or GitHub OAuth.

---

# Phase 3 — Local Database Architecture

## Objective

Make SQLite the default database for local installations.

Suggested directory:

```text
~/.netpro/
├── config.toml
├── netpro.db
├── logs/
└── keys/
```

## Default

```text
SQLite
```

## Optional

```text
PostgreSQL
```

PostgreSQL is intended for:

- Docker deployments
- teams
- larger installations
- remote servers
- production self-hosting

## Configuration

Example:

```toml
[database]
dialect = "sqlite"
path = "~/.netpro/netpro.db"
```

PostgreSQL:

```toml
[database]
dialect = "postgresql"
url = "postgresql://..."
```

## Important

The application must not require:

```text
DATABASE_URL
```

for local SQLite use.

## Exit criteria

Fresh installation works with:

```bash
netpro init
netpro serve
```

without PostgreSQL.

---

# Phase 4 — Remove Vercel-Specific Assumptions

## Objective

Replace Vercel deployment assumptions with generic Node execution.

Search for and remove dependencies on:

```text
vercel.json
VERCEL
VERCEL_ENV
Vercel-specific runtime behavior
Vercel deployment URLs
Vercel build commands
Vercel serverless functions
Vercel-specific filesystem assumptions
```

## Build scripts

Replace deployment-specific commands with standard scripts.

Target:

```bash
npm run build
npm run test
npm run lint
npm run typecheck
```

The application must not require:

```bash
npm run vercel-build
```

## Exit criteria

A clean checkout can build using standard Node/npm/Turborepo commands.

---

# Phase 5 — Redesign Authentication

## Objective

Remove GitHub OAuth as a prerequisite for local NetPro.

## Local mode

Local NetPro should not require:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
NETPRO_OWNER_GITHUB_ID
NEXTAUTH_SECRET
NEXTAUTH_URL
```

just to run the application.

## Local identity

Introduce a local installation identity.

Example:

```text
~/.netpro/config.toml
```

Potential model:

```text
installation
    id
    created_at
    owner/profile
```

The local server can trust requests originating from its local UI when bound to `127.0.0.1`.

## Remote/self-hosted mode

Authentication can be enabled when the server is exposed remotely.

Possible future mechanisms:

- local account authentication
- OAuth
- OIDC
- reverse-proxy authentication

GitHub OAuth can remain an optional integration rather than the application's fundamental identity system.

## Exit criteria

Local NetPro starts without GitHub credentials.

---

# Phase 6 — Define the Web API

## Objective

Create a stable API contract between server and Web UI.

Suggested endpoints:

```text
GET    /api/health

GET    /api/contacts
GET    /api/contacts/:id

GET    /api/search
GET    /api/graph
GET    /api/graph/path

GET    /api/analytics
GET    /api/analytics/network

POST   /api/import
GET    /api/import/:id

POST   /api/scan
GET    /api/jobs
GET    /api/jobs/:id

GET    /api/events
GET    /api/settings
```

The exact routes should be finalized from the existing Web API implementation before migration.

## API rule

Routes orchestrate.

Core performs the actual work.

Bad:

```text
React → custom search implementation
```

Good:

```text
React
  ↓
Server API
  ↓
packages/core
  ↓
database
```

## Exit criteria

Every Web UI data requirement has a defined server API.

---

# Phase 7 — Build the Job System

## Objective

Make long-running NetPro operations observable.

Create a common job model:

```text
Job
├── id
├── type
├── status
├── progress
├── started_at
├── completed_at
├── error
└── metadata
```

Job types:

```text
import
scan
enrich
index
embed
graph
analyze
```

Statuses:

```text
queued
running
completed
failed
cancelled
```

## Example

```text
Scan
  0%   queued
 15%   discovering
 40%   processing
 70%   enriching
 90%   indexing
100%   completed
```

## Exit criteria

CLI and server use the same job model.

---

# Phase 8 — Add Event Streaming

## Objective

Allow the Web UI to visualize NetPro activity in real time.

Initial transport:

```text
Server-Sent Events (SSE)
```

Events:

```text
scan.started
scan.progress
scan.completed

contact.imported
contact.updated

relationship.discovered
relationship.updated

graph.updated

search.started
search.completed

enrichment.started
enrichment.completed

job.failed
```

Example:

```json
{
  "type": "scan.progress",
  "jobId": "abc123",
  "progress": 42,
  "message": "Processing connections"
}
```

## Exit criteria

A running CLI/server operation produces events visible to the Web UI.

---

# Phase 9 — Rebuild the Web UI Foundation

## Objective

Turn `apps/web` into a visualization and control interface.

Suggested navigation:

```text
NetPro
├── Observatory
├── Network
├── Search
├── People
├── Activity
└── Settings
```

The Web UI should communicate with:

```text
http://127.0.0.1:3777
```

or the configured NetPro server.

## UI principle

The UI should answer:

> What is NetPro doing, what did it discover, and what can I do with it?

Not:

> How do I configure a cloud deployment?

---

# Phase 10 — Build the Observatory

## Objective

Create the primary dashboard.

Show:

```text
Network size
Relationships
Communities
Recent activity
Current jobs
Last scan
Enrichment status
Index status
Graph status
```

Example:

```text
┌────────────────────────────────────────────┐
│ NETPRO OBSERVATORY                         │
├────────────────────────────────────────────┤
│ Contacts       Relationships    Communities│
│ 4,821          18,203           37         │
├────────────────────────────────────────────┤
│ Current Activity                           │
│                                            │
│ ███████████████░░░  78%                    │
│ Scanning professional network              │
├────────────────────────────────────────────┤
│ Recent discoveries                         │
│                                            │
│ • New relationship                         │
│ • Contact enriched                         │
│ • Community updated                        │
└────────────────────────────────────────────┘
```

---

# Phase 11 — Network Visualization

## Objective

Make the graph the visual centerpiece.

Show:

- people
- relationships
- relationship strength
- communities
- clusters
- bridges
- high-degree nodes
- important intermediaries

The UI should consume graph results from `packages/core`.

It should not implement graph algorithms.

Existing algorithms such as:

- Louvain community detection
- degree centrality
- Brandes betweenness
- warm-introduction pathfinding

remain in the backend/core.

## Exit criteria

The graph can be explored interactively from the Web UI.

---

# Phase 12 — Search Experience

## Objective

Expose NetPro's existing search capabilities through a clear interface.

Support:

```text
Name
Company
Role
Location
Skills
Tags
Relationship strength
Community
```

Show why a result matched.

Example:

```text
Sarah Chen

Matched because:
✓ Works at Acme
✓ 2nd-degree relationship
✓ Shared AI/ML skill
✓ Strong relationship with Alex
```

The UI must call the existing hybrid search implementation.

---

# Phase 13 — Pathfinder

## Objective

Make:

> Who can introduce me to this person?

a first-class workflow.

Example:

```text
You
 ↓
Alex
 ↓
Maria
 ↓
Target
```

Show:

```text
Path strength
Weakest relationship
Average relationship
Number of hops
Intermediate contacts
```

Use the existing path-ranking model rather than reimplementing it in React.

---

# Phase 14 — Scan Visualization

## Objective

Make scanning understandable.

Show:

```text
SCAN
────────────────────────

Source
LinkedIn CSV / configured source

Progress
████████████████░░░░ 82%

Processed
3,942 / 4,821

New contacts
128

Updated contacts
391

Relationships discovered
2,103

Enrichment
████████████░░░░░░░ 61%
```

Activity should update through SSE.

---

# Phase 15 — Import Experience

## Objective

Move imports from a CLI-only experience to a unified workflow.

Support:

```text
CLI:
netpro import linkedin.csv

Web:
Upload → Preview → Validate → Import
```

The Web UI should trigger a server job.

The same import logic must be used by CLI and Web UI.

No duplicate importer.

---

# Phase 16 — CLI ↔ Web UI Integration

## Objective

Ensure both interfaces are clients of the same system.

Example:

```bash
netpro scan
```

The UI immediately shows:

```text
Scan started
```

Then:

```text
23%
41%
68%
100%
```

Likewise, starting a scan from the UI should produce the same backend job that the CLI uses.

## Rule

One operation:

```text
One core implementation
One job system
One event stream
Multiple interfaces
```

---

# Phase 17 — Optional AI and Enrichment

## Objective

Make external providers optional.

NetPro should function without:

```text
OpenAI
Anthropic
Hunter
People Data Labs
Clearbit
embedding providers
```

When configured, providers enhance functionality.

When not configured:

```text
NetPro still runs.
```

The Web UI should clearly show provider status.

Example:

```text
AI
● Not configured

Enrichment
● Hunter configured

Embeddings
● Disabled
```

---

# Phase 18 — Packaging and Installation

## Objective

Make the local application easy to install.

Target:

```bash
npm install -g netpro
```

Then:

```bash
netpro init
netpro serve
```

Optional:

```bash
netpro import linkedin.csv
netpro scan
netpro search "AI founders"
```

## Ideal experience

```text
$ netpro init

Created ~/.netpro

Database: SQLite
Server: 127.0.0.1:3777

$ netpro serve

NetPro running at:
http://127.0.0.1:3777
```

---

# Phase 19 — Docker Self-Hosted Deployment

## Objective

Support users who want a persistent server.

Create:

```text
Dockerfile
docker-compose.yml
```

Target architecture:

```text
Browser
   ↓
NetPro Server
   ↓
PostgreSQL
```

Optional reverse proxy:

```text
Internet
   ↓
Caddy / Nginx / Traefik
   ↓
NetPro
```

## Requirements

- PostgreSQL support
- persistent storage
- environment configuration
- migrations
- health checks
- logs
- optional authentication

Docker deployment must work without any Vercel dependency.

---

# Phase 20 — Delete Vercel Completely

## Objective

Remove Vercel from the repository and project architecture.

This phase happens only after the local server, Web UI, database, API, jobs, events, authentication, and deployment paths are working.

## Delete

```text
vercel.json
```

Remove:

```text
vercel-build
```

Remove Vercel-specific environment variables and documentation.

Remove deployment instructions referring to:

```text
Vercel
Vercel Postgres
Vercel serverless functions
Vercel build configuration
Vercel deployment URLs
```

Remove Vercel-specific dependencies if they exist.

## Search again

```bash
grep -Rni "vercel" . --exclude-dir=node_modules --exclude-dir=.git
```

The expected result should be empty, except for historical changelog material if intentionally retained.

## Exit criteria

There is no Vercel deployment path.

NetPro builds and runs without Vercel.

---

# Phase 21 — CI/CD Redesign

## Objective

CI must validate the actual NetPro architecture.

Pipeline:

```text
Install
  ↓
Lint
  ↓
Typecheck
  ↓
Unit tests
  ↓
SQLite integration tests
  ↓
PostgreSQL integration tests
  ↓
Build
  ↓
CLI smoke tests
  ↓
Server smoke tests
  ↓
Web UI smoke tests
```

## Test commands

Target:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Add explicit tests for:

```text
netpro init
netpro serve
/api/health
SQLite startup
PostgreSQL startup
API calls
SSE
Web UI loading
```

---

# Phase 22 — Migration Testing

## Objective

Protect existing users.

Test migrations against:

```text
fresh SQLite database
existing SQLite database
fresh PostgreSQL database
existing PostgreSQL database
```

Verify:

- contacts preserved
- relationships preserved
- interactions preserved
- graph data preserved
- indexes rebuilt correctly
- workspace data preserved
- encrypted secrets remain usable
- migration failures are recoverable

## Backup

Before migration:

```text
~/.netpro/netpro.db
```

should be safely backed up.

Potential command:

```bash
netpro backup
```

And:

```bash
netpro restore backup.json
```

or a database-native backup format where appropriate.

---

# Phase 23 — Security Hardening

## Local mode

Default:

```text
127.0.0.1
```

Protect:

- database files
- credential storage
- API keys
- imported data
- uploaded files
- logs
- exports

## Remote mode

Require explicit configuration for:

- network exposure
- authentication
- TLS/reverse proxy
- allowed origins
- session security
- rate limiting

## Plugins

Keep the existing warning:

> Plugins execute in-process and are not sandboxed.

Do not imply that installing a plugin is equivalent to installing an isolated extension.

## Webhooks

Validate:

- target URLs
- authentication
- retries
- SSRF/private-network risks
- timeout limits
- payload size

---

# Phase 24 — Deprecate the Old Web Architecture

## Objective

Remove remaining legacy assumptions after the new architecture has stabilized.

Review:

```text
apps/web
apps/cli
packages/core
packages/db
packages/server
```

Remove:

- duplicated API logic
- duplicated business logic
- obsolete Auth.js flows
- obsolete Next.js server actions
- old deployment configuration
- cloud-only environment requirements
- unused API routes
- legacy pages
- migration compatibility code that is no longer required

## Final architecture

```text
NetPro
│
├── apps/
│   ├── cli/
│   └── web/
│
├── packages/
│   ├── core/
│   ├── db/
│   ├── server/
│   └── config/
│
├── plugins/
├── docs/
└── scripts/
```

---

# Final Product Modes

## Mode 1 — Local

Default and recommended.

```text
CLI
 ↓
Local Server
 ↓
SQLite
 ↑
Web UI
```

Commands:

```bash
netpro init
netpro serve
```

Privacy promise:

> Your professional network can remain entirely on your machine.

---

## Mode 2 — Self-Hosted

For advanced users and teams.

```text
Browser
   ↓
NetPro Server
   ↓
PostgreSQL
```

Deploy with Docker.

No Vercel dependency.

---

## Mode 3 — Hosted

**Not part of this implementation.**

The project should not depend on a hosted service to function.

The open-source application must remain fully usable without a NetPro-owned cloud deployment.

---

# Recommended Implementation Order

Do not execute all phases as one large rewrite.

Use these milestones.

## Milestone 1 — Architecture

```text
Phase 0
Phase 1
Phase 2
```

Deliverable:

```bash
netpro serve
```

starts a local server.

---

## Milestone 2 — Local Runtime

```text
Phase 3
Phase 4
Phase 5
```

Deliverable:

```bash
netpro init
netpro serve
```

works with SQLite and no GitHub OAuth.

---

## Milestone 3 — Backend Platform

```text
Phase 6
Phase 7
Phase 8
```

Deliverable:

```text
API
Jobs
SSE
```

are stable.

---

## Milestone 4 — Web UI

```text
Phase 9
Phase 10
Phase 11
```

Deliverable:

```text
Observatory
Network Graph
Activity
```

---

## Milestone 5 — Core Workflows

```text
Phase 12
Phase 13
Phase 14
Phase 15
```

Deliverable:

```text
Search
Pathfinder
Scanning
Import
```

are available through the Web UI.

---

## Milestone 6 — Unified Application

```text
Phase 16
Phase 17
Phase 18
```

Deliverable:

```text
CLI
   ↕
Server
   ↕
Web UI
```

all use the same underlying operations.

---

## Milestone 7 — Self Hosting

```text
Phase 19
Phase 21
Phase 22
Phase 23
```

Deliverable:

```text
Local SQLite
+
Docker PostgreSQL
```

are both reliable.

---

## Milestone 8 — Vercel Removal

```text
Phase 20
Phase 24
```

Deliverable:

```text
ZERO VERCEL DEPENDENCY
```

---

# Definition of Done

The migration is complete when a fresh user can do:

```bash
npm install -g netpro
netpro init
netpro serve
```

and receive:

```text
┌──────────────────────────────────────┐
│              NETPRO                  │
│                                      │
│  Your professional network.          │
│  Private. Local. Searchable.         │
│                                      │
│  Contacts       4,821                │
│  Relationships  18,203               │
│  Communities    37                   │
│                                      │
│  [ Network ] [ Search ] [ Activity ] │
└──────────────────────────────────────┘
```

The user can then:

```bash
netpro import linkedin.csv
netpro scan
netpro search "AI founders"
```

while the Web UI displays the operations in real time.

The application must work with:

```text
No Vercel
No Vercel account
No Vercel deployment
No Vercel database
No mandatory GitHub OAuth
No mandatory cloud service
```

The final principle is:

> **NetPro is the application. The Web UI is its observatory, not its backend.**
