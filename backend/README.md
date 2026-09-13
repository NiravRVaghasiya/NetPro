# NetPro Python Backend

The Python-first implementation of NetPro, grown phase by phase from
[`../NetPro_Python_First_Implementation_Plan.md`](../NetPro_Python_First_Implementation_Plan.md).
This is **Phase 1 — the Python foundation**: project layout, toolchain and
conventions, with no production feature migrated yet. The TypeScript packages
(`packages/`, `apps/`) remain the authoritative implementation until each
Python phase reaches parity.

## Quick start

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/):

```bash
cd backend
uv sync                 # create .venv and install exactly uv.lock
uv run pytest           # test suite
uv run ruff check .     # lint
uv run ruff format --check .
uv run mypy             # strict type check
```

Run the API skeleton (binds `127.0.0.1:3777` by default — loopback only,
exposing it further is an explicit choice):

```bash
uv run netpro serve
curl -s localhost:3777/api/health
# {"status":"healthy","dialect":"sqlite","latencyMs":0,"timestamp":"2026-…Z"}

uv run netpro --version
# 3.0.2
```

## Layout

```
src/netpro/
  config/          Settings — env vars compatible with the TS configuration
  errors.py        Structured errors (code + message + details)
  observability.py Logging conventions: request ids, context, never secrets
  domain/          Business rules (Phase 3: scoring, follow-ups, dedupe)
  application/     Use cases — one rule, one implementation (later phases)
  intelligence/    Graph + search + ranking (Phases 4–5)
  integrations/    LinkedIn import, enrichment, AI providers (Phases 6–8)
  infrastructure/  SQLAlchemy 2 over the existing schema (Phase 2)
  api/             FastAPI — thin routes, TS-compatible contracts
  cli/             Typer — same use cases as the API
  jobs/            Background jobs + SSE semantics (Phase 11)
```

## Conventions established in Phase 1

* **Configuration**: `Settings` reads the exact environment variables the TS
  server reads (`NETPRO_HOME`, `NETPRO_HOST`/`HOST`, `NETPRO_PORT`/`PORT`,
  `NETPRO_AUTH_MODE`, `DB_DIALECT`, …). Unknown auth modes/dialects are a
  loud error, never a silent fallback. `~/.netpro/config.toml` support lands
  with Phase 2, keeping the TS precedence: env → config file → defaults.
* **Errors**: every deliberate failure is a `NetProError` with a stable
  `code`. Over HTTP it serializes as `{"error": …, "code": …}` — the exact
  TS response shape, so the web UI keeps working as routes migrate.
* **API**: `create_app(settings)` factory (dependency injection over
  globals), `x-request-id` on every response, `Cache-Control: no-store` on
  API responses, `/api/health` envelope byte-compatible with the TS probe.
* **Logging**: one `configure_logging()` per process; request id and
  workspace id flow via `ContextVar`s; secrets never appear in logs.
* **Types**: mypy `strict` from day one — the migration's safety net
  (contract tests between two languages) depends on types being trustworthy.
* **Version**: `netpro.__version__` tracks the workspace version in the root
  `package.json` (pinned together by test, like the TS `bundle.test.ts`).

## Sandbox note (toolchain)

This development sandbox cannot download prebuilt CPython builds, so CPython
3.12.14 was built once from source (static OpenSSL 3.0.22 + SQLite 3.53.2
with FTS5 + zlib — the same SQLite feature set better-sqlite3 compiles) and
snapshotted. Run `bash ~/.pythons/bootstrap.sh` at session start to restore
`python3.12` and `uv`; normal environments (CI, laptops, containers) need
nothing of this — `uv sync` just works there.
