# Phase 22 — Migration testing

**Generated:** 2026-09-11
**Follows:** [Phase 21](phase-21-cicd-redesign.md)

## Objective

Protect existing users. Every earlier phase proved its own migration in
isolation (fresh apply, upgrade from the immediate predecessor, idempotency);
this phase proves the whole journey an existing install actually takes, and
makes a bad migration recoverable:

```text
fresh SQLite      existing SQLite       fresh PostgreSQL      existing PostgreSQL
     │                  │                      │                       │
     └──────┬───────────┘                      └───────────┬───────────┘
            │                                              │
   migration-preservation.test.ts              postgres.preservation.test.ts
   (hermetic, every `npm test`)                (live server, CI postgres job)
```

plus `netpro backup` / `netpro restore` and a pre-migration safety copy in
`netpro migrate`, so “migration failures are recoverable” is a command, not a
hope.

---

## The preservation matrix

| Database | Fixture | Suite |
|----------|---------|-------|
| Fresh SQLite | empty file → all 15 migrations | `migrations.test.ts` (per-migration) + preservation re-run |
| Existing SQLite (v2.5-era) | 0000–0007 + a row in every data table → full | `migration-preservation.test.ts` |
| Existing SQLite (v3.0-era) | 0000–0010 + vault + authorship → full | `migration-preservation.test.ts` |
| Fresh PostgreSQL | empty database → all 15 migrations | `postgres.integration.test.ts` |
| Existing PostgreSQL (v2.5-era) | 0000–0007 + a row in every data table → full | `postgres.preservation.test.ts` |
| Existing PostgreSQL (v3.0-era) | 0000–0010 + vault → full | `postgres.preservation.test.ts` |

The v2.5-era fixture seeds contacts (including a soft-deleted row, which must
stay deleted), interactions, edges with provenance, events + attendees,
enrichments, campaigns + recipients, a search-index row, a profile view, a
follow-up, an activity row, a profile card, and content items/metrics/mentions.
After the upgrade the suite asserts:

- every row preserved, value-for-value (scores, provenance, JSON verdicts);
- every `workspace_id` backfilled to `default`, none left NULL;
- the FTS5 mirror (SQLite) / generated `tsvector` (PostgreSQL) finds the
  preserved document, and new writes still sync;
- every index family rebuilt (CRM, edges, search, views, content, workspace
  composites, authorship, assignment, webhooks);
- the journal is complete and a re-run is a no-op.

The v3.0-era fixture asserts vault ciphertext byte-identical after the
upgrade. “Encrypted secrets remain usable” is that byte-preservation composed
with the crypto round-trip in `packages/core/src/crypto/vault.test.ts`, which
proves the same master key decrypts the same bytes — the migration suite does
not reimplement AES to re-prove it.

The failure-recovery test (both dialects) injects a future migration with
invalid SQL: the run rejects, the journal and every row are untouched, and the
very next run with the correct folder succeeds — failures are never cached
(`runMigrations` drops the per-process entry on error) and never half-applied
(Drizzle wraps each migration in a transaction).

One subtlety the suite pins: Drizzle decides what is pending by comparing the
journal `when` against the last applied row, not by counting entries — a
regression test with a backdated `when` would no-op instead of failing.

## Backup and restore (`packages/db/src/backup.ts`)

| Operation | SQLite | PostgreSQL |
|-----------|--------|------------|
| `netpro backup` | SQLite backup API (consistent while open, WAL folded in) → `<home>/backups/netpro-<stamp>.db` | `pg_dump --format=custom` → `<home>/backups/netpro-<stamp>.dump` |
| `netpro restore <file>` | validates (magic header + migration journal), keeps a `pre-restore-<stamp>.db` safety copy, replaces, drops stale `-wal`/`-shm`, re-verifies migrations | sniffs custom vs plain-SQL → `pg_restore --clean --if-exists` / strict single-transaction `psql` |
| `netpro backup --list` | newest-first inventory of the backup directory | same |

Details that matter:

- A backup never migrates first: the CLI opens with `createDb()`, not
  `openDb()`, so it snapshots exactly what is on disk.
- Every backup and safety copy is stored mode 0600 (Phase 23) — a backup is a
  full copy of the professional network.
- Overwrites are refused unless `--force` is given; restoring a file onto
  itself is refused; non-NetPro files (CSV exports, truncated copies) are
  refused before anything is touched.
- `NETPRO_BACKUP_DIR` relocates the directory (portable installs, volumes).
- PostgreSQL has no automatic safety copy — `netpro backup` first, then
  `netpro restore`. A missing `pg_dump`/`pg_restore`/`psql` produces
  installation advice (or the `docker compose exec db …` equivalent), and
  `pg_dump` stderr is surfaced instead of swallowed.

## Pre-migration safety copy (`netpro migrate`)

`netpro migrate` takes a `pre-migrate-<stamp>.db` backup before applying
anything when — and only when — all of these hold:

1. the run is not `--status`,
2. `--no-backup` was not passed,
3. at least one migration is pending,
4. the database is an on-disk SQLite file (`:memory:` has nothing to preserve;
   PostgreSQL dumps are `netpro backup`'s job — a deploy step should not
   `pg_dump` a team database unasked).

A failed backup fails the migration loudly, naming the backup directory and
the override. `--status`, no-op runs, and `:memory:` take no backup, which
keeps the pre-existing migrate tests hermetic without changes.

Stop `netpro serve` before restoring: the running server holds the previous
image open and must be restarted to see the restored one. The restore output
says so every time.

## Smoke coverage

`scripts/smoke/cli.sh` gained the recoverability loop over a scratch install:
`netpro backup` → 0600 timestamped snapshot → `backup --list` inventories it →
`netpro restore` round-trips with a `pre-restore-*` safety copy → `migrate
--status` still reports 15/15. The failure-recovery path stays in vitest,
where invalid SQL cannot escape into a shared fixture.

## Exit criteria

| Criterion | Status |
|-----------|--------|
| Fresh SQLite migrates clean | ✅ pre-existing + preservation re-run |
| Existing SQLite (v2.5 + v3.0 eras) preserves every table | ✅ `migration-preservation.test.ts` |
| Fresh PostgreSQL migrates clean | ✅ pre-existing `postgres.integration.test.ts` |
| Existing PostgreSQL (v2.5 + v3.0 eras) preserves every table | ✅ `postgres.preservation.test.ts` (CI) |
| Contacts, relationships, interactions, graph, indexes, workspaces, vault bytes verified | ✅ both suites |
| Migration failures leave data + journal intact and recover on retry | ✅ both suites |
| `~/.netpro/netpro.db` backed up before migration | ✅ `netpro backup` + `netpro migrate` safety copy |
| `netpro backup` / `netpro restore` (+ `--list`) on both dialects | ✅ CLI + smoke |
