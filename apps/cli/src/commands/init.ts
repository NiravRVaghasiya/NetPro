import type { Command } from 'commander';
import type { InstallationIdentity, PgConn, SqliteConn } from '@netpro/db';

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
  /** Phase 5 — the local installation identity (minted here if absent). */
  installation: InstallationIdentity;
  installationCreated: boolean;
  /** Where the optional remote-access token lives (mode 0600). */
  tokenPath: string;
  /** True when this run minted a token (an existing one is never replaced). */
  tokenCreated: boolean;
  /** Display-safe token preview — never the full value. */
  tokenPreview: string;
  /** Exposed so callers (tests, embedders) can release the handle. */
  conn: SqliteConn | PgConn;
}

export interface InitOptions {
  /** Display name to record on first creation (ignored if one exists). */
  owner?: string;
  email?: string;
}

/** Default config.toml written on first init. Every setting is a commented no-op. */
export function defaultConfigToml(): string {
  return `# NetPro configuration
# Local docs: docs/local-first.md
# Environment variables (DB_DIALECT, DB_PATH, DATABASE_URL, NETPRO_HOST,
# NETPRO_PORT, NETPRO_AUTH_MODE) override anything written here.

[database]
# dialect = "sqlite"              # "sqlite" (default) or "postgresql"
# path = "~/.netpro/netpro.db"    # SQLite file (~/ expanded; relative = install dir)
# url = "postgresql://…"          # Required when dialect = "postgresql"

[server]
# host = "127.0.0.1"              # Loopback by default — expose deliberately.
# port = 3777
# allowed_origins = "https://ui.example.com"   # CSV browser origins (default: loopback only)

[auth]
# mode = "local"                  # local (default) | token | open
#   local — requests from this machine are trusted; other machines need the
#           access token in ~/.netpro/keys/access-token (netpro token).
#   token — every request needs the access token, including this machine.
#   open  — no authentication at all; only behind your own auth proxy/VPN.

# The installation identity below is written by netpro init and is what
# identifies this install (it replaces "sign in with GitHub" for local use).
# Uncomment owner to label it with your name.
[installation]
# owner = "Your name"
# email = "you@example.com"
`;
}

/**
 * `netpro init` — create the local install, its identity, and its database.
 *
 * Creates `~/.netpro/` (config.toml, logs/, keys/), mints the installation
 * identity and the optional remote-access token (Phase 5), opens the
 * configured database (SQLite by default, at <home>/netpro.db), and applies
 * pending migrations. Idempotent: an existing config.toml is never
 * overwritten, an existing identity/token is never replaced, and re-running
 * against a migrated database is a no-op.
 *
 * Exit criteria (Phase 3): a fresh machine works with `netpro init` +
 * `netpro serve` — no PostgreSQL, no DATABASE_URL.
 * Exit criteria (Phase 5): and no GitHub OAuth either — init is where the
 * local installation identity comes from.
 */
export async function executeInit(
  env: NodeJS.ProcessEnv = process.env,
  options: InitOptions = {}
): Promise<InitResult> {
  const {
    appliedMigrationCount,
    createDb,
    describeConn,
    ensureAccessToken,
    ensureInstallationIdentity,
    pendingMigrationTotal,
    redactAccessToken,
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

  // 2. Phase 5 identity: the local install *is* the owner, so init mints the
  //    installation id (written into [installation]) and a token for the day
  //    the server is exposed beyond loopback. Neither is regenerated.
  const { identity: installation, created: installationCreated } = ensureInstallationIdentity(
    env,
    { owner: options.owner, email: options.email }
  );
  const token = ensureAccessToken(env);

  // 3. Database: default SQLite at <home>/netpro.db. Migrations run
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
    installation,
    installationCreated,
    tokenPath: token.path,
    tokenCreated: token.created,
    tokenPreview: redactAccessToken(token.token),
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
    .description('Create the local install (~/.netpro), identity, and database')
    .option('--owner <name>', 'Display name to record for this installation')
    .option('--email <address>', 'Contact email to record for this installation')
    .action(async (options: { owner?: string; email?: string }) => {
      // Imported lazily so `--help` never loads the native database drivers.
      const { closeConn } = await import('@netpro/db');
      let result: InitResult | undefined;
      try {
        result = await executeInit(process.env, options);
        const pending = Math.max(0, result.total - result.applied);
        const dbState =
          pending === 0
            ? `${result.applied}/${result.total} migrations applied`
            : `${result.applied}/${result.total} migrations applied, ${pending} pending`;
        console.log('NetPro initialized');
        console.log('');
        console.log(`${result.configCreated ? 'Created' : 'Using'} ${result.home}`);
        console.log(
          `Database: ${result.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'} — ` +
            `${result.databaseDisplay} (${dbState})`
        );
        console.log('Server:   127.0.0.1:3777');
        console.log(
          `Config:   ${result.configPath} ${result.configCreated ? '(created)' : '(kept existing)'}`
        );
        console.log(
          `Identity: ${result.installation.id}${result.installation.owner ? ` (${result.installation.owner})` : ''}` +
            `${result.installationCreated ? ' — created' : ' — existing'}`
        );
        console.log(
          `Token:    ${result.tokenPreview} at ${result.tokenPath} ` +
            `${result.tokenCreated ? '(created)' : '(existing)'}`
        );
        console.log('');
        console.log('Next steps:');
        console.log('  netpro serve                       start the local server + Web UI');
        console.log('  netpro status                      install, database, and server health');
        console.log('  netpro import --linkedin <file>    import a LinkedIn connections export');
        console.log('');
        console.log(
          'The token is only needed if you expose the server beyond this machine;'
        );
        console.log('`netpro token` prints it any time.');
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
