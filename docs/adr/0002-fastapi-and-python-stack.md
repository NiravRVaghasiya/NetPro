# 0002 — FastAPI and the Python stack

- **Status:** accepted
- **Date:** 2026-09-22
- **Phase:** Python migration Phase 1
- **Supersedes:** —

## Context

ADR 0001 chose a strangler migration to a Python-first NetPro. Phase 1 has to
introduce Python without changing user-visible behaviour, which means the stack
must be decided *before* any capability moves — otherwise each phase picks its
own tools and the "one business rule, one implementation" rule dies by a
thousand imports.

Constraints:

- The HTTP contract is frozen (`docs/python-migration/api-contracts.md`); the
  framework must be able to reproduce exact bodies, headers, and status codes —
  including odd ones, such as a 404 for an unsupported method on a known path.
- The CLI contract is frozen too: `--json` must print the same object the API
  returns.
- Existing databases must open unchanged: SQLite by default, PostgreSQL
  first-class, timestamps as ISO-8601 **text**.
- Local-first: no server-side session store, no OAuth, no telemetry, no extra
  infrastructure.
- A single contributor must be able to run `uv sync && uv run pytest &&
  uv run netpro serve` without archaeology.

## Decision

Adopt a deliberately boring, mature stack, all of it declared in
`backend/pyproject.toml`:

| Concern | Choice | Why |
| --- | --- | --- |
| Python | **3.12+** | Plan §4 floor; 3.13 also in the CI matrix |
| Packaging | **uv** + `pyproject.toml`, `src/` layout, PEP 735 `dependency-groups` | One tool for env, lockfile, and run; `src/` prevents importing the tree instead of the package |
| API | **FastAPI** + **Pydantic v2** | Typed request/response models give exact JSON shapes; ASGI middleware keeps SSE (Phase 11) unbuffered |
| ORM / migrations | **SQLAlchemy 2**, **Alembic** | Declared in Phase 1, used in Phase 2 so persistence lands as a code change, not a dependency change |
| CLI | **Typer** | Same typed-function ergonomics as FastAPI; one `netpro` entry point |
| HTTP client | **httpx** | Sync + async, and the ASGI transport the tests use |
| Server | **uvicorn** | Default ASGI server |
| Lint + format | **Ruff** | One tool, fast, `select` list in pyproject |
| Types | **mypy --strict** + the Pydantic plugin | Errors become type errors, not 500s |
| Tests | **pytest** + **pytest-asyncio** | Hermetic; `contract` marker for frozen-parity tests |
| Jobs | asyncio, in-process | Revisit in ADR 0005 (Phase 11) |
| Graph | NetworkX (Phase 4) | Revisit in ADR 0004 if measured |

Layout, also fixed here:

```text
backend/
  pyproject.toml
  src/netpro/{api,application,cli,config,domain,infrastructure,intelligence,integrations,jobs}
  tests/{unit,contract}
```

With four rules that the tooling enforces or the review must:

1. `netpro.domain` imports nothing from NetPro — no framework, no I/O.
2. Use cases live in `netpro.application`; API routes and CLI commands are
   adapters and hold no business rule.
3. Adapters live in `netpro.infrastructure` and implement ports declared in
   `netpro.domain.ports`; the API container wires them.
4. Errors are `NetProError` subclasses rendered as `{"error": ...}`.

Deliberate sub-decisions, recorded because they will otherwise be "fixed" by a
well-meaning later commit:

- **No PEP 695 syntax** (`class Page[T]:`, `type X = ...`) even though the floor
  is 3.12, so the suite stays parseable by a 3.11 interpreter and can be
  verified on toolchains that do not have 3.12. `UP046`/`UP047` are ignored in
  the Ruff config for exactly this reason.
- **Interactive API docs are disabled** (`docs_url`/`redoc_url`/`openapi_url`
  are `None`). A local-first server that binds `127.0.0.1` ships no browsable
  surface; the contract lives in `docs/`.
- **`config.toml` uses a hand-written strict subset parser**, not `tomllib`, to
  stay byte-compatible with the TypeScript parser's error messages and its
  rejection of arrays/inline tables/dotted keys. Both implementations read the
  same file on the same machine.
- **The console script is named `netpro`** inside the Python environment. The
  npm binary keeps the name outside it; the Python CLI takes over in Phase 13.

## Consequences

**Positive**

- One dependency set, one formatter, one test runner: a contributor's first
  command is `uv sync`.
- Pydantic models make the frozen JSON shapes explicit and testable
  (`HealthReport.to_api_json()` reproduces the captured fixture key for key).
- ASGI middleware keeps the door open for SSE without a rewrite.
- Strict mypy from day one means Phase 2's SQLAlchemy models arrive in a tree
  that already fails on an untyped call.

**Negative / costs**

- FastAPI/Pydantic are heavier than a hand-rolled `node:http` equivalent; the
  TypeScript server has no framework at all. Accepted: the Python side trades a
  dependency for typed request/response models it will need across ~50 routes.
- Two lockstep toolchains (npm + uv) in one repository until Phase 17.
- Declaring SQLAlchemy/Alembic before using them is unusual; it is intentional
  and expires in Phase 2.

**Neutral**

- `uv.lock` is not committed yet: it can only be produced on a machine with a
  3.12 interpreter. CI runs `uv sync` (which resolves on the fly) and the first
  Phase 2 change should commit the lock and switch to `uv sync --frozen`.
