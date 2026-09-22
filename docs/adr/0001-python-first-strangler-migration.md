# 0001 — Python-first via strangler migration

- **Status:** accepted
- **Date:** 2026-09-22
- **Phase:** Python migration Phase 1
- **Supersedes:** —

## Context

NetPro v3.0.2 is a substantial TypeScript monorepo: a dual-dialect Drizzle
persistence layer, `@netpro/core` with all business logic (import, hybrid
search, Louvain/Brandes graph analytics, CRM scoring, AI drafting, enrichment,
campaigns, plugins, webhooks), a `node:http` API with jobs and SSE, a 27-command
CLI, and a Next.js 16 UI — 397 TypeScript files, ~86.5k lines, 155 test files,
green CI.

The product's centre of gravity is graph analytics, ranking, and
data-processing work, which is where Python's ecosystem is strongest. At the
same time, the existing implementation is correct, tested, and shipped; users
have SQLite and PostgreSQL databases that must keep opening.

Two options were on the table:

1. **Rewrite** NetPro in Python and cut over.
2. **Strangler migration**: keep the TypeScript product running and shipped,
   grow a Python implementation module by module, switch each consumer when the
   Python side has golden-test parity, then delete the TypeScript module.

## Decision

Take option 2. Python becomes the authoritative implementation of NetPro's
domain, intelligence, integrations, API, CLI, and jobs; the TypeScript tree
remains the shipped product until each capability has been replaced and
verified.

Non-negotiables that follow from this:

- **One business rule, one implementation.** A Python module replaces the
  TypeScript one; it never runs beside it in production. Two scoring functions
  is a bug, not a migration state.
- **Contract-first.** Every capability is captured by tests/fixtures in
  TypeScript terms, implemented in Python, compared against the same fixtures,
  and only then switched over. The frozen baseline is v3.0.2
  (`docs/python-migration/00-baseline.md`).
- **The UI stays TypeScript/Next.js** initially. "Python-first" does not mean
  "Python in the browser".
- **No new infrastructure by association.** No Redis, Celery, Kafka,
  Kubernetes, or microservices because they are common elsewhere; the target is
  a Python modular monolith.
- **Data compatibility.** Existing `~/.netpro/netpro.db` and existing PostgreSQL
  installs keep working; the schema is not redesigned because a new language
  arrived.
- **Both CI gates run** until the TypeScript backend is removed (Phase 17).

Order of work (do not skip): foundation → database → domain → graph → search →
LinkedIn/keys → imports/providers → AI → CRM → campaigns → jobs/SSE → API → CLI
→ UI retarget → security audit → plugins → remove TS core.

## Consequences

**Positive**

- The shipped product stays green throughout; no big-bang risk window.
- Each capability can be compared numerically (scores, ranks, graph metrics,
  API JSON) before the switch, which is the only honest way to preserve
  hand-tuned formulas like RRF (k=60) or `0.6 × weakestTie + 0.4 × mean hop`.
- Work lands in the order Python is strongest, so the first migrations carry
  the biggest payoff.

**Negative / costs**

- Two implementations of some capabilities exist in the repository
  simultaneously. This is contained by the capability matrix
  (`docs/python-migration/capability-matrix.md`), which names the owner and the
  phase for every capability.
- Contributors must know which implementation is authoritative for a given
  capability. The capability matrix is the answer, and it must be kept current.
- Contract fixtures and cross-language tests are permanent overhead — they are
  also the safety net that makes the rest possible.

**Neutral**

- The TypeScript CLI tarball remains the release artifact until Phase 17, so
  `package:check` and the smoke stages stay in CI even while Python grows.
