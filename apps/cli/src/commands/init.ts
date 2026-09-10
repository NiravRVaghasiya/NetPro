import type { Command } from 'commander';
import type { PgConn, SqliteConn } from '@netpro/db';

export interface InitResult {
  home: string;
  logs: string;
  keys: string;
  configPath: string;
  /** True when this run wrote a fresh config.toml (existing files are kept). */
  configCreated: boolean;
  dialect: 'sqlite' | 'postgresql';
  /** Display-safe database location (path or redacted URL). */
  databaseDisplay: string;
  applied: number;
  total: number;
  /** Exposed so callers (tests, embedders) can release the handle. */
  conn: SqliteConn | PgConn;
}

/** Default config.toml written on first init. Every setting is a commented no-op. */
export function defaultConfigToml(): string {
  return `# NetPro configuration
# Local docs: docs/local-first.md
# Environment variables (DB_DIALECT, DB_PATH, DATABASE_URL, NETPRO_HOST,
# NETPRO_PORT) override anything written here.

[database]
# dialect = "sqlite"              # "sqlite" (default) or "postgresql"
# path = "~/.netpro/netpro.db"    # SQLite file (~/ expanded; relative = install dir)
# url = "postgresql://…"          # Required when dialect = "postgresql"

[server]
# host = "127.0.0.1"              # Loopback by default — expose deliberately.
# port = 3777
`;
}

/**
 * `netpro init` — create the local install and database.
 *
 * Creates `~/.netpro/` (config.toml, logs/, keys/), opens the configured
 * database (SQLite by default, at <home>/netpro.db), and applies pending
 * migrations. Idempotent: an existing config.toml is never overwritten and
 * re-running against a migrated database is a no-op.
 *
 * Exit criteria (Phase 3): a fresh machine works with `netpro init` +
 * `netpro serve` — no PostgreSQL, no DATABASE_URL, no GitHub OAuth.
 */
export async function executeInit(env: NodeJS.ProcessEnv = process.env): Promise<InitResult> {
  const {
    appliedMigrationCount,
    createDb,
    describeConn,
    pendingMigrationTotal,
    runMigrations,
  } = await import('@netpro/db');
  const { configTomlPath, ensureNetProHome } = await import('@netpro/db/src/local');
  const { writeFileSync, existsSync } = await import('node:fs');

  // 1. Directory layout: ~/.netpro/{config.toml, logs/, keys/}
  const layout = ensureNetProHome(env);
  const configPath = configTomlPath(env);
  const configCreated = !existsSync(configPath);
  if (configCreated) {
    writeFileSync(configPath, defaultConfigToml(), { mode: 0o644 });
  }

  // 2. Database: default SQLite at <home>/netpro.db. Migrations run
  //    explicitly here — init is the "set up my install" step, mirroring
  //    `netpro migrate` (force bypasses the per-process promise cache).
  const conn = createDb(env);
  try {
    await runMigrations(conn, { force: true });
  } catch (error) {
    const { closeConn } = await import('@netpro/db');
    await closeConn(conn);
    throw error;
  }
  const applied = await appliedMigrationCount(conn).catch(() => 0);
  const total = pendingMigrationTotal(conn.dialect);

  return {
    home: layout.home,
    logs: layout.logs,
    keys: layout.keys,
    configPath,
    configCreated,
    dialect: conn.dialect,
    databaseDisplay: describeConn(conn, env),
    applied,
    total,
    conn,
  };
}

/** Turn the failures operators actually hit into actionable advice. */
export function initFailureHint(message: string): string | null {
  if (/DATABASE_URL is required/.test(message)) {
    return (
      'dialect = "postgresql" needs a connection string: set DATABASE_URL, or add ' +
      'url = "postgresql://…" under [database] in ~/.netpro/config.toml. ' +
      'For local single-user use, keep the default sqlite dialect — it needs nothing.'
    );
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(message)) {
    return 'The database is unreachable. Check the host, port, and any IP allow list.';
  }
  if (/SELF_SIGNED_CERT|self[- ]signed certificate|unable to verify/i.test(message)) {
    return (
      'TLS verification failed. Append ?sslmode=require to DATABASE_URL for providers that ' +
      'use their own CA (Supabase, Neon), or set NETPRO_DB_SSL_CA to the CA certificate.'
    );
  }
  return null;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create the local install (~/.netpro) and database')
    .action(async () => {
      // Imported lazily so `--help` never loads the native database drivers.
      const { closeConn } = await import('@netpro/db');
      let result: InitResult | undefined;
      try {
        result = await executeInit();
        const pending = Math.max(0, result.total - result.applied);
        const dbState =
          pending === 0
            ? `${result.applied}/${result.total} migrations applied`
            : `${result.applied}/${result.total} migrations applied, ${pending} pending`;
        console.log('NetPro initialized');
        console.log('');
        console.log(`Install:  ${result.home}`);
        console.log(
          `Config:   ${result.configPath} ${result.configCreated ? '(created)' : '(kept existing)'}`
        );
        console.log(`Database: ${result.databaseDisplay} (${dbState})`);
        console.log('');
        console.log('Next steps:');
        console.log('  netpro serve                       start the local server + Web UI');
        console.log('  netpro status                      install, database, and server health');
        console.log('  netpro import --linkedin <file>    import a LinkedIn connections export');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ netpro init failed: ${message}`);
        const hint = initFailureHint(message);
        if (hint) console.error(`  ${hint}`);
        process.exitCode = 1;
      } finally {
        if (result) await closeConn(result.conn);
      }
    });
}
