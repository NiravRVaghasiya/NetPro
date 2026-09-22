# Python-first migration — governance docs

Phase 0 of [NetPro_Python_First_Implementation_Plan.md](../../NetPro_Python_First_Implementation_Plan.md).

These documents freeze the TypeScript product as it exists at **v3.0.2** so the Python migration can proceed without silently changing behaviour.

| Document | Purpose |
| --- | --- |
| [00-baseline.md](00-baseline.md) | Frozen commit, package inventory, architecture, test/CI status, risks |
| [capability-matrix.md](capability-matrix.md) | Every product capability → owner package, CLI, API, UI, Python phase |
| [api-contracts.md](api-contracts.md) | HTTP API, jobs, SSE, auth, error shapes — the contract the UI already depends on |
| [data-model.md](data-model.md) | Dual-dialect schema, 27 tables, 15 migrations, FTS, ID/timestamp policy |
| [migration-rules.md](migration-rules.md) | Non-negotiable rules, golden-test strategy, security inventory, plugin/job boundaries |

Fixtures for later golden tests live in [`fixtures/`](fixtures/).

**Status:** Phase 0 complete. Next is Phase 1 — `backend/` Python foundation (`uv`, Ruff, pytest) with no production feature moved yet.
