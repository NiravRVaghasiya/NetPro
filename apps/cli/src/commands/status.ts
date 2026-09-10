import type { Command } from 'commander';

export interface StatusResult {
  home: string;
  configPath: string;
  configExists: boolean;
  database: {
    dialect: string | null;
    display: string | null;
    applied: number | null;
    total: number | null;
    error: string | null;
  };
  server: {
    url: string;
    running: boolean;
    status: string | null;
    dialect: string | null;
    latencyMs: number | null;
    error: string | null;
  };
}

/** Health probe timeout — a local server answers instantly or it's down. */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Where the local server should be, from the same precedence `netpro serve`
 * uses: NETPRO_URL (probing a remote/self-hosted instance) → NETPRO_HOST/
 * NETPRO_PORT env → config.toml [server] → 127.0.0.1:3777. loadConfig() from
 * @netpro/server implements the last three; it is a leaf module (only
 * @netpro/db's config reader), so importing it keeps `status` light.
 */
export async function resolveServerUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const direct = env.NETPRO_URL?.trim();
  if (direct) return direct.replace(/\/+$/, '');
  const { loadConfig } = await import('@netpro/server/config');
  const { host, port } = loadConfig(env);
  return `http://${host}:${port}`;
}

/**
 * `netpro status` — one-screen answer to "what is my install doing?"
 *
 * Reports the local install (directory, config), the database (dialect,
 * location, migration state), and probes the local server's /api/health.
 * Read-only: nothing is created or migrated. Exits 0 even when the server
 * is down — being down is a status, not a failure of the status command.
 */
export async function executeStatus(env: NodeJS.ProcessEnv = process.env): Promise<StatusResult> {
  const { configTomlPath, netproHome } = await import('@netpro/db/src/local');
  const { existsSync } = await import('node:fs');

  const home = netproHome(env);
  const configPath = configTomlPath(env);
  const configExists = existsSync(configPath);

  const result: StatusResult = {
    home,
    configPath,
    configExists,
    database: { dialect: null, display: null, applied: null, total: null, error: null },
    server: {
      url: '',
      running: false,
      status: null,
      dialect: null,
      latencyMs: null,
      error: null,
    },
  };

  // A broken config.toml is a status line (with the file's own error), never
  // a crash — the whole point of `status` is to explain a broken install.
  let serverUrl: string | null = null;
  try {
    serverUrl = await resolveServerUrl(env);
    result.server.url = serverUrl;
  } catch (error) {
    result.server.error = error instanceof Error ? error.message : String(error);
  }

  // ── Database ── Read-only snapshot; any failure is a status line, not a crash.
  const { appliedMigrationCount, closeConn, createDb, describeConn, pendingMigrationTotal } =
    await import('@netpro/db');
  let conn: import('@netpro/db').SqliteConn | import('@netpro/db').PgConn | undefined;
  try {
    conn = createDb(env);
    result.database.dialect = conn.dialect;
    result.database.display = describeConn(conn, env);
    const [applied, total] = await Promise.all([
      appliedMigrationCount(conn).catch(() => null),
      Promise.resolve(pendingMigrationTotal(conn.dialect)),
    ]);
    result.database.applied = applied;
    result.database.total = total;
  } catch (error) {
    result.database.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (conn) await closeConn(conn);
  }

  // ── Server ── Probe /api/health with a short timeout.
  if (serverUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const started = Date.now();
      const res = await fetch(`${serverUrl}/api/health`, { signal: controller.signal });
      const body = (await res.json()) as { status?: string; dialect?: string };
      result.server.running = res.ok;
      result.server.status = body.status ?? `HTTP ${res.status}`;
      result.server.dialect = body.dialect ?? null;
      result.server.latencyMs = Date.now() - started;
    } catch (error) {
      result.server.error =
        error instanceof Error && error.name === 'AbortError'
          ? `no response within ${PROBE_TIMEOUT_MS} ms`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return result;
}

export function formatStatus(result: StatusResult): string {
  const config = result.configExists ? result.configPath : `${result.configPath} (missing — run netpro init)`;

  let db: string;
  if (result.database.error) {
    db = `unavailable — ${result.database.error}`;
  } else if (result.database.applied === null) {
    // A database file with no migrations journal: created but never initialized.
    db = `${result.database.display} (${result.database.dialect}, not initialized — run netpro init)`;
  } else if (result.database.total !== null) {
    const pending = Math.max(0, result.database.total - result.database.applied);
    db =
      `${result.database.display} (${result.database.dialect}, ` +
      (pending === 0
        ? `${result.database.applied}/${result.database.total} migrations`
        : `${pending} migration(s) PENDING`) +
      ')';
  } else {
    db = `${result.database.display} (${result.database.dialect})`;
  }

  const server = result.server.running
    ? `running at ${result.server.url} — ${result.server.status}, ${result.server.dialect}, ${result.server.latencyMs} ms`
    : `not running (expected at ${result.server.url} — start it with \`netpro serve\`)`;

  return [
    'NetPro status',
    '',
    `Install:  ${result.home}`,
    `Config:   ${config}`,
    `Database: ${db}`,
    `Server:   ${server}`,
  ].join('\n');
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show install, database, and local server status')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await executeStatus();
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatStatus(result));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ netpro status failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
