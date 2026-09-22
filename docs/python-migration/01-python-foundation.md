# Phase 1 — Python foundation

> Status: **complete**. The TypeScript product is unchanged and still ships.

Parent plan: [NetPro_Python_First_Implementation_Plan.md](../../NetPro_Python_First_Implementation_Plan.md) §4.
Governance: [README](README.md) · [migration-rules.md](migration-rules.md).
Decisions recorded: [ADR 0001](../adr/0001-python-first-strangler-migration.md) · [ADR 0002](../adr/0002-fastapi-and-python-stack.md).

**Objective (plan §4):** introduce Python without changing user-visible
behaviour. No production feature was moved out of `@netpro/core`.

---

## What landed

```text
backend/
├── pyproject.toml          uv project, Python 3.12+, Ruff/mypy/pytest config
├── README.md               how to develop, layer rules, conventions
├── .python-version         3.12
├── src/netpro/
│   ├── config/             install layout · config.toml subset · settings
│   ├── domain/             errors · ids · time · scope · paging · ports
│   ├── application/        use-case protocols + the health use case
│   ├── intelligence/       (empty — Phases 4–5)
│   ├── integrations/       (empty — Phases 6–8)
│   ├── infrastructure/     structured, redacting logging
│   ├── api/                FastAPI app, container, middleware, error envelope
│   ├── cli/                Typer: `netpro version`, `netpro serve`
│   └── jobs/               frozen job/event names (registry is Phase 11)
└── tests/{unit,contract}/
```

Plus:

| Path | Purpose |
| --- | --- |
| `.github/workflows/python-ci.yml` | Python gate **beside** `ci.yml` (rules §14) |
| `docs/adr/0001…`, `0002…`, `docs/adr/README.md` | ADRs the rules require with Phase 1 |
| `backend/README.md` | Contributor entry point |

**Counts:** 44 Python files (32 source, 12 test) · ~3,220 source lines ·
~1,550 test lines · **140 tests**, of which **11** are marked `contract`.

---

## Conventions established (plan §4 checklist)

| Convention | Where | Rule |
| --- | --- | --- |
| Dependency injection | `api/container.py` | A frozen `ApiContainer` dataclass on `app.state`; no registry, no import-time singletons |
| Typed interfaces | `domain/ports.py` | `Clock`, `UnitOfWork`, `ReadRepository` protocols; adapters implement them |
| Async boundaries | `application/usecase.py` | `UseCase` vs `AsyncUseCase`; only I/O paths are async |
| Structured errors | `domain/errors.py` | `NetProError` subclasses with `code` + `status_code` + `headers` |
| Configuration | `config/settings.py` | env → `config.toml` → defaults; invalid config is a loud error |
| Logging | `infrastructure/logging.py` | One JSON line per record; credentials redacted |
| Repository pattern | `domain/ports.py` | Declared, not blanket-applied — added where it earns its place |
| Transaction boundaries | `domain/ports.py` | `with transaction(uow): …`; commit failure rolls back |
| Timezone policy | `domain/time.py` | Aware UTC internally; `…T00:00:00.000Z` text on the wire and in the DB |
| ID policy | `domain/ids.py` | UUID v4 rows · `ins_…` installs · `np_…` tokens · mask to last 4 |
| Pagination | `domain/paging.py` | `limit` (default 25, max 100) + `offset` |
| API error format | `api/errors.py` | `{"error": …}`; 404 `Not found: METHOD path`; 500 `Internal server error` |
| Tenancy | `domain/scope.py` | Every query scoped; un-scoped ⇒ bootstrap workspace `default` |
| CLI output | `cli/output.py` | `--json` prints the API payload |

---

## Behaviour preserved (contract-tested)

Frozen against `fixtures/api/` and the TypeScript sources, not against what the
new code happens to do:

- `GET /api/health` and the `/health` alias — body key set, `status`,
  `dialect`, `latencyMs`, ISO-8601-millis `timestamp`; `?verbose` detail gated
  to the local operator; `degraded`/503 when migrations are not fully applied.
- `GET /api/server-info` — every field of `server-info.json`. **One additive
  field**: `implementation: "python"` (plus `version`), so a UI can tell which
  side of the strangler answered. Nothing was renamed or removed.
- Transport — `application/json; charset=utf-8`, `Cache-Control: no-store,
  max-age=0`, `X-Request-Id` (echoed, capped at 128), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS only when
  opted in.
- Unknown `/api/*` → `404 {"error": "Not found: GET /api/…"}`; **an unsupported
  method on a known path is also a 404**, because the TypeScript router keys on
  method+path and never emits 405. Non-API paths → `404 {"error": "Not found"}`.
  Uncaught error → `500 {"error": "Internal server error", "message": …}`.
- The 401 body — `{"error", "reason", "authMode", "hint"}` plus
  `WWW-Authenticate: Bearer realm="netpro"`, byte-identical to
  `unauthorized.json`.
- Job/event vocabulary — `EVENT_TYPES`, `JOB_TYPES`, `JOB_STATUSES` are asserted
  **against the TypeScript source files**, and every key of `job.json` is a
  known field or camel/snake alias.
- `config.toml` — the same subset, and the same error sentences with the same
  line numbers, as `packages/db/src/local.ts`. Precedence
  (env → file → defaults), dialect aliases, port fallback, `[server]`/
  `[installation]`/`[auth]` unknown-key rejection, and the `[database]`
  permissiveness asymmetry are all mirrored.

---

## Verification

Run in the sandbox that authored this phase (Python **3.11.2**, the only
interpreter available; see "Known gaps" for what that means):

| Check | Command | Result |
| --- | --- | --- |
| Lint | `ruff check .` | **Pass** — 0 errors (Ruff 0.16.8) |
| Format | `ruff format --check .` | **Pass** — 45 files already formatted |
| Types | `mypy` | **Pass** — strict, 44 source files, 0 errors |
| Tests | `pytest` | **Pass** — 140 passed in 0.35s |
| Contract tests | `pytest -m contract` | **Pass** — 11 passed |
| Dependency resolution for 3.12 | `uv pip compile --python-version 3.12 --group dev` | **Pass** — full pinned set resolves |

Dependency versions in that run are the same ones `uv` resolves for 3.12
(fastapi 0.141.1, pydantic 2.13.5, SQLAlchemy 2.0.54, alembic 1.20.0,
typer 0.27.2, httpx 0.28.1, uvicorn 0.53.0, pytest 9.1.1, pytest-asyncio 1.4.0,
ruff 0.16.8, mypy 2.3.1) — only the interpreter differs.

Two real defects were found by the tests before this phase was called done, and
both are fixed:

1. **Proxy-header trust bypass.** `request_trust._read_header` compared
   lower-case names against a plain `dict`, so a header bag carrying
   `X-Forwarded-For` (canonical case) was not seen — loopback trust would have
   survived a reverse proxy, which is precisely the case rules §10.2 exists to
   catch. Header lookup is now case-insensitive for every bag type.
2. **A failed commit was not rolled back.** `transaction()` rolled back only for
   errors raised inside the block; a rejected `commit()` left the transaction
   open. It now rolls back and re-raises.

### Known gaps in verification

- **`uv sync` was not run here.** The sandbox has no CPython 3.12 and cannot
  download one (`github.com` is unreachable from it), and `requires-python =
  ">=3.12"` is a hard constraint for `uv`. The suite was therefore run in a
  3.11 virtualenv installed with `pip install --ignore-requires-python`, with
  the dependency set resolved for 3.12 by `uv pip compile`. **CI
  (`.github/workflows/python-ci.yml`) runs the literal plan §4 exit criteria —
  `uv sync`, `uv run pytest`, `uv run ruff check .`,
  `uv run ruff format --check .` — on 3.12 and 3.13.**
- **`uv.lock` is not committed** for the same reason. Commit it (and switch CI
  to `uv sync --frozen`) as the first Phase 2 change.
- Nothing in this phase touches a database, so no persistence behaviour was
  exercised. That is Phase 2.

---

## Deliberately not in Phase 1

| Missing | Lands in | Note |
| --- | --- | --- |
| Database access, SQLAlchemy models, Alembic | **2** | Health reports the *configured* dialect; `LatencyHealthProbe` does no I/O and never claims the schema is applied |
| Domain objects (Person, Relationship, …) | 3 | Only the conventions exist |
| Graph / search | 4 / 5 | `netpro.intelligence` is empty on purpose |
| Credential verification, CORS, rate limiting | 15 | `request_trust` classifies trust only. It never verifies a token, so `authenticationRequired` is `true` for a remote caller in `local`/`token` mode even with a valid token. No protected route exists yet, so nothing is exposed |
| Jobs, SSE | 11 | Names frozen in `netpro.jobs.contract` |
| The rest of the route table | 12 | Public probes only |
| The 27-command CLI | 13 | `version` + `serve` only |
| Plugins | 16 | TS runtime stays authoritative (rules §11) |

`netpro serve --host 0.0.0.0` prints a warning that the Python backend does not
verify tokens yet and that binding a loopback address is the safe choice until
Phase 15.

---

## Exit criteria (plan §4)

| Criterion | Status |
| --- | --- |
| `backend/` with `pyproject.toml`, `src/` layout, the nine packages | **Yes** |
| Python 3.12+, uv, Ruff, pytest, Pydantic, SQLAlchemy, Alembic, FastAPI, Typer, httpx configured | **Yes** — all declared; FastAPI/Pydantic/Typer/httpx/uvicorn are used, SQLAlchemy/Alembic wait for Phase 2 |
| Conventions documented and encoded | **Yes** — table above |
| Python project installs cleanly | **Yes** in CI (`uv sync`); locally verified via a 3.11 venv + 3.12 dependency resolution |
| `pytest` / `ruff check` / `ruff format --check` pass | **Yes** — plus `mypy --strict` |
| No production feature migrated | **Yes** — the TypeScript tree is untouched |
| TypeScript product still runnable | **Yes** — no npm workspace, script, or `packages/` file changed |

---

## Next

Phase 2 — database & persistence (plan §5): SQLAlchemy models over the existing
27-table schema, one repository hiding the dialect split, Alembic stamped on
`0014_webhooks`, and a `DatabaseHealthProbe` so `/api/health` reports real
migration counts. Commit `uv.lock` first.
