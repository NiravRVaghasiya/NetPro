# NetPro backend (Python)

The Python side of the NetPro migration. **This is the foundation, not the
product.** As of migration Phase 1 the shipped NetPro is still the TypeScript
monorepo in this repository (`packages/`, `apps/`); this tree contains the
conventions, the toolchain, and the two public probes that later phases build
on.

See:

- [`../NetPro_Python_First_Implementation_Plan.md`](../NetPro_Python_First_Implementation_Plan.md) — the plan
- [`../docs/python-migration/`](../docs/python-migration/README.md) — governance: baseline, capability matrix, API contracts, data model, rules
- [`../docs/adr/`](../docs/adr/) — the decisions this tree encodes

## Requirements

Python **3.12+** and [`uv`](https://docs.astral.sh/uv/).

## Getting started

```bash
cd backend
uv sync                            # install runtime + dev dependencies
uv run pytest                      # the whole suite (hermetic, no network)
uv run ruff check .                # lint
uv run ruff format --check .       # formatting
uv run mypy                        # strict type checking
uv run netpro version              # the Phase 1 CLI
uv run netpro serve                # http://127.0.0.1:3777/api/health
```

`uv sync` creates `.venv/` and installs the package in editable mode, so
`import netpro` resolves to `src/netpro`.

## What Phase 1 provides

| Area | Module | Status |
| --- | --- | --- |
| Install layout, `config.toml` subset, settings | `netpro.config` | done — mirrors `packages/db/src/local.ts` |
| Errors, ids, timestamps, workspace scope, paging, ports | `netpro.domain` | conventions done; domain objects are Phase 3 |
| Use-case protocols + the health use case | `netpro.application` | done |
| Structured, redacting logging | `netpro.infrastructure` | done |
| `GET /api/health`, `/health`, `GET /api/server-info` | `netpro.api` | done — contract-tested against the Phase 0 fixtures |
| Job/event **names** (registry is Phase 11) | `netpro.jobs` | contract frozen |
| `netpro version`, `netpro serve` | `netpro.cli` | done; the 27-command CLI is Phase 13 |
| Graph, search, integrations | `netpro.intelligence`, `netpro.integrations` | intentionally empty |

Deliberately **not** here yet: database access and Alembic (Phase 2), domain
objects (Phase 3), credentials/auth verification, CORS and rate limiting
(Phase 15), jobs and SSE (Phase 11), the rest of the route table (Phase 12).

## Layer rules

```text
api / cli  →  application  →  domain  ←  infrastructure (implements domain ports)
```

- `netpro.domain` imports nothing from NetPro. No FastAPI, no Typer, no
  SQLAlchemy.
- `netpro.application` holds use cases. One operation, one implementation —
  the API route, the CLI command, and the job runner are adapters around it.
- `netpro.infrastructure` implements the ports declared in
  `netpro.domain.ports`; the API container wires them together.
- `netpro.api` and `netpro.cli` never contain a business rule.

## Conventions

| Concern | Rule |
| --- | --- |
| Errors | Raise `NetProError` subclasses; the API renders `{"error": ...}` |
| Time | Timezone-aware UTC internally, ISO-8601 text (`…T00:00:00.000Z`) on the wire and in the database |
| Ids | UUID v4 strings for rows, `ins_…` installations, `np_…` tokens |
| Tenancy | Every query is workspace-scoped; un-scoped means the bootstrap workspace `default` |
| Paging | `limit` (default 25, max 100) + `offset` |
| Transactions | Explicit: `with transaction(uow): …` |
| Secrets | Never logged, never returned raw; masked to the last four characters |
| CLI output | `--json` prints exactly the object the HTTP API returns |

## Tests

```bash
uv run pytest                      # everything
uv run pytest -m contract          # only the frozen-contract tests
uv run pytest -m "not contract"    # everything else
```

The suite is hermetic: the install directory is a temp path, the environment is
an explicit mapping, the API is called in-process through
`httpx.ASGITransport`, and no test opens a socket or a database. The
`contract` tests read the TypeScript sources and the Phase 0 fixtures directly,
so a rename on either side of the migration fails the other one's suite.
