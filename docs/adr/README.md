# Architecture decision records

Decisions that shape the codebase, recorded when they are made — not
reconstructed later. `docs/python-migration/migration-rules.md` §2 says an
intentional behaviour change requires an ADR here plus a README note; §15 lists
the ADRs the Python migration needs and when.

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-python-first-strangler-migration.md) | Python-first via strangler migration, not a rewrite | accepted |
| [0002](0002-fastapi-and-python-stack.md) | FastAPI + Pydantic v2 + SQLAlchemy 2 + Typer, packaged with uv | accepted |

Planned, not yet written (per `migration-rules.md` §15):

| ID | Decision | Expected phase |
| --- | --- | --- |
| 0003 | SQLAlchemy 2 + Alembic stamped on the existing 15 migrations | 2 |
| 0004 | Graph engine: NetworkX vs igraph | 4 |
| 0005 | Background jobs: in-memory vs DB vs ARQ | 11 |
| 0006 | Frontend boundary: keep Next.js | 14 |

## Conventions

- One decision per file, numbered in the order accepted.
- Sections: **Status**, **Context**, **Decision**, **Consequences**.
- A decision is replaced by a new ADR that marks the old one superseded;
  ADRs are never edited into a different decision after acceptance.
