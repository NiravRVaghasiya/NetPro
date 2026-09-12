// packages/server/src/serve.ts
//
// Phase 2 — `netpro serve`: the one command that makes NetPro runnable
// entirely on the user's machine, with no cloud infrastructure.
//
// Phase 5 — the banner also names the local installation identity and the
// authentication mode, and a remote bind is never accidentally unprotected:
// a non-loopback `local` bind mints an access token when none exists, and an
// `open` bind says out loud that it answers anyone.
//
// Defaults come from the plan: 127.0.0.1:3777. `~/.netpro/config.toml`
// ([server], [auth]) and NETPRO_HOST/NETPRO_PORT/NETPRO_AUTH_MODE override
// them; explicit options (the CLI's --host/--port) override everything. The
// banner mirrors the plan's example so a fresh `netpro serve` reads exactly
// like the spec:

//     NetPro server started
//
//     Local:    http://127.0.0.1:3777  (API + built-in console)
//     Database: ~/.netpro/netpro.db
//
//     Web UI:   not running — start it with `npm run dev -w apps/web`
//
// The banner used to print the same address twice, once as `Local:` and once
// as `Web UI:`, which read like two services and was wrong twice over: this
// process serves the REST API and the built-in console page (routes/home.ts),
// while the full Web UI is the separate Next.js app in apps/web that talks to
// this port over HTTP. `Web UI:` now names that app's real address when the
// operator configures one (NETPRO_WEB_URL / [server] web_url) and otherwise
// says it is not running, instead of pointing at the API.

import {
  describeConn,
  ensureAccessToken,
  LocalConfigError,
  redactAccessToken,
  type PgConn,
  type SqliteConn,
} from '@netpro/db';
import { authStartupDiagnostics, describeAuthPolicy, loadAuthPolicy, type AuthPolicy } from './auth/index';
import { createApp, type NetProApp } from './app';
import { loadConfig } from './config';
import { startRetentionSchedule } from './retention';
import type { RunningServer } from './server';
import { startServer } from './server';

export type RunServeOptions = {
  /** Bind address; beats env and config.toml. Must default to loopback. */
  host?: string;
  /** TCP port; beats env and config.toml. 0 binds an ephemeral port (tests). */
  port?: number;
  /** Environment overlay (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Output sink (tests). Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Signals bound to graceful shutdown. Defaults to SIGINT + SIGTERM.
   * Pass [] to disable handlers entirely (tests drive close() themselves).
   */
  signals?: NodeJS.Signals[];
  /**
   * Mint an access token automatically when a non-loopback bind would
   * otherwise be unprotected (default true). Tests and embedders that manage
   * their own install set this to false.
   */
  createTokenOnRemoteBind?: boolean;
};

export type ServeStopReason =
  | { reason: 'signal'; signal: NodeJS.Signals }
  | { reason: 'close' };

export type ServeHandle = RunningServer & {
  /** Resolves after the server has stopped and DB resources are released. */
  stopped: Promise<ServeStopReason>;
};

/** Loopback addresses are the only safe default bind. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}

/** Turn raw listen() failures into messages a user can act on. */
export function friendlyListenError(error: unknown, host: string, port: number): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'EADDRINUSE') {
    return new Error(
      `Port ${port} is already in use — is NetPro already running? ` +
        `Stop the other process or pick another port: netpro serve --port <number>.`
    );
  }
  if (code === 'EACCES') {
    return new Error(
      `Port ${port} requires elevated privileges. Pick a port above 1024: netpro serve --port <number>.`
    );
  }
  if (code === 'EADDRNOTAVAIL') {
    return new Error(
      `Cannot bind to ${host} — the address does not exist on this machine. ` +
        `Use 127.0.0.1 (the default) or check NETPRO_HOST / [server] host in ~/.netpro/config.toml.`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Resolve the auth policy for a bind, creating a token when a non-loopback
 * `local` bind would otherwise deny every remote caller.
 *
 * This is the one place NetPro writes a credential on the user's behalf, and
 * it only does so when the alternative is a server that cannot be used — never
 * on a plain loopback start.
 */
export function prepareAuthPolicy(
  env: NodeJS.ProcessEnv,
  host: string,
  mode: Parameters<typeof loadAuthPolicy>[1],
  options: { createTokenOnRemoteBind?: boolean } = {}
): { policy: AuthPolicy; createdToken: string | null } {
  const policy = loadAuthPolicy(env, mode);
  const create = options.createTokenOnRemoteBind ?? true;
  if (create && policy.mode === 'local' && !isLoopbackHost(host) && !policy.token) {
    const created = ensureAccessToken(env);
    return {
      policy: { ...policy, token: created.token },
      createdToken: created.token,
    };
  }
  return { policy, createdToken: null };
}

/**
 * Create the app, bind the port, print the startup banner, and wire
 * graceful shutdown. Resolves once listening; await `handle.stopped` to
 * block until shutdown completes (this is what `netpro serve` does).
 */
export async function runServe(options: RunServeOptions = {}): Promise<ServeHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));

  const config = loadConfig(env);
  if (options.host !== undefined) config.host = options.host;
  if (options.port !== undefined) config.port = options.port;

  const { policy, createdToken } = prepareAuthPolicy(env, config.host, config.auth.mode, {
    createTokenOnRemoteBind: options.createTokenOnRemoteBind,
  });

  const diagnostics = authStartupDiagnostics(policy, {
    host: config.host,
    isLoopbackHost: isLoopbackHost(config.host),
  });
  const fatal = diagnostics.find((d) => d.level === 'error');
  if (fatal) throw new LocalConfigError(fatal.message);

  // The environment overlay must reach createDb() too: config came from
  // loadConfig(env), so the database must resolve from the same overlay —
  // otherwise an embedder/tests' scratch NETPRO_HOME/DB_PATH is silently
  // ignored and the server opens ~/.netpro/netpro.db instead.
  const app = await createApp({ config, auth: policy, env });

  let running: RunningServer;
  try {
    running = await startServer(app, { host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => {});
    throw friendlyListenError(error, config.host, config.port);
  }

  // Phase 24 — the daily retention purge moved here from the Web UI's
  // instrumentation. It is self-guarded (at most one run per 24 h) and
  // `null` when NETPRO_DISABLE_RETENTION=true; failures are logged, never
  // thrown, so it cannot break startup or the request path.
  const retentionSchedule = startRetentionSchedule(app.conn, env, log);

  printBanner(running, app, env, policy, createdToken, log);
  for (const warning of diagnostics.filter((d) => d.level === 'warning')) {
    log(`⚠ ${warning.message}`);
    log('');
  }
  printRemoteExposureSummary(config.host, app, log);

  let resolveStopped: (reason: ServeStopReason) => void = () => {};
  const stopped = new Promise<ServeStopReason>((resolve) => {
    resolveStopped = resolve;
  });

  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const onSignal = (signal: NodeJS.Signals): void => {
    retentionSchedule?.stop();
    void running
      .close()
      .catch(() => {})
      .then(() => resolveStopped({ reason: 'signal', signal }));
  };
  for (const signal of signals) {
    process.once(signal, onSignal);
  }

  return {
    ...running,
    stopped,
    close: async () => {
      try {
        retentionSchedule?.stop();
        await running.close();
      } finally {
        for (const signal of signals) process.removeListener(signal, onSignal);
        resolveStopped({ reason: 'close' });
      }
    },
  };
}

function printBanner(
  running: RunningServer,
  app: NetProApp,
  env: NodeJS.ProcessEnv,
  policy: AuthPolicy,
  createdToken: string | null,
  log: (line: string) => void
): void {
  const conn: SqliteConn | PgConn = app.conn;
  const database = describeConn(conn, env);

  // A wildcard bind has no browsable address of its own — point the user at
  // loopback (reachable whenever the wildcard bind succeeded) and warn.
  const isWildcard = running.host === '0.0.0.0' || running.host === '::';
  const displayUrl = isWildcard
    ? `http://127.0.0.1:${running.port}`
    : running.url;

  log('NetPro server started');
  log('');
  // Say what actually answers on this port: the REST API plus the built-in
  // console page. Calling it the "Web UI" sent people looking for the
  // Observatory on an address that only serves a status page.
  log(`Local:    ${displayUrl}  (API + built-in console)`);
  log(`Database: ${database}`);
  if (policy.installation) {
    const owner = policy.installation.owner ? ` (${policy.installation.owner})` : '';
    log(`Identity: ${policy.installation.id}${owner}`);
  } else {
    log('Identity: not initialized — run `netpro init` to create one');
  }
  log(`Auth:     ${describeAuthPolicy(policy)}`);
  log('');
  // The Web UI is a separate process (apps/web). Only claim an address when
  // one is configured; otherwise tell the user how to start it.
  if (app.config.webUrl) {
    log(`Web UI:   ${app.config.webUrl}  (separate app, points at this server)`);
  } else {
    log('Web UI:   not running — start it with `npm run dev -w apps/web`');
    log('          (set NETPRO_WEB_URL or [server] web_url once it has a fixed address)');
  }
  log('');

  if (createdToken) {
    // Printed once, on the machine's own console. The value lives in
    // ~/.netpro/keys/access-token (mode 0600); `netpro token` shows it again.
    log(
      `Created an access token for remote callers: ${redactAccessToken(createdToken)}`
    );
    log('  Show it any time with `netpro token`; the full value is in ~/.netpro/keys/access-token.');
    log('');
  }
}

/**
 * Phase 23 — a non-loopback bind is a deliberate exposure: name the policy
 * guarding it on every start, not just in the docs. Loopback starts stay
 * quiet (there is nothing to review).
 */
function printRemoteExposureSummary(
  host: string,
  app: NetProApp,
  log: (line: string) => void
): void {
  if (isLoopbackHost(host)) return;
  const origins = app.security.allowedOrigins
    ? app.security.allowedOrigins.join(', ')
    : 'loopback origins only (default; set NETPRO_ALLOWED_ORIGINS for a remote UI)';
  const rl = app.config.rateLimit;
  const limit =
    rl && rl.enabled
      ? `${rl.max} req/${Math.max(1, Math.round(rl.windowMs / 1000))}s per IP`
      : 'disabled (NETPRO_RATE_LIMIT_ENABLED=0)';
  log(`Remote bind (${host}): browser origins: ${origins}; rate limit: ${limit}; HSTS: ${app.security.hsts ? 'on' : 'off'}.`);
  if (!app.security.hsts) {
    log('  No TLS here — terminate HTTPS at a reverse proxy (nginx/Caddy) for anything beyond a trusted LAN. See docs/deployment.md.');
  }
  log('');
}

/**
 * Entry point for the standalone `netpro-server` bin. The full CLI surface
 * (`netpro serve`) lives in apps/cli and reuses runServe directly.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let host: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: netpro-server [--host 127.0.0.1] [--port 3777]

NetPro local HTTP server (standalone bin).
Prefer \`netpro serve\` from the CLI. Default bind: 127.0.0.1:3777
Auth: loopback requests are trusted; remote requests need the access token
      (~/.netpro/keys/access-token, or NETPRO_AUTH_TOKEN).
`);
      return;
    }
  }

  try {
    const handle = await runServe({ host, port });
    const stop = await handle.stopped;
    if (stop.reason === 'signal') {
      console.log(`\nReceived ${stop.signal}, shutting down…`);
    }
  } catch (error) {
    if (error instanceof LocalConfigError) {
      console.error(`✗ ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }
}
