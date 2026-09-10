// packages/server/src/serve.ts
//
// Phase 2 — `netpro serve`: the one command that makes NetPro runnable
// entirely on the user's machine, with no Vercel, no cloud infrastructure,
// and no GitHub OAuth.
//
// Defaults come from the plan: 127.0.0.1:3777. `~/.netpro/config.toml`
// ([server]) and NETPRO_HOST/NETPRO_PORT override them; explicit options
// (the CLI's --host/--port) override everything. The banner mirrors the
// plan's example so a fresh `netpro serve` reads exactly like the spec:

//     NetPro server started
//
//     Local:    http://127.0.0.1:3777
//     Database: ~/.netpro/netpro.db
//
//     Web UI:   http://127.0.0.1:3777

import {
  describeConn,
  LocalConfigError,
  type PgConn,
  type SqliteConn,
} from '@netpro/db';
import { createApp, type NetProApp } from './app';
import { loadConfig } from './config';
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

  const app = await createApp({ config });

  let running: RunningServer;
  try {
    running = await startServer(app, { host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => {});
    throw friendlyListenError(error, config.host, config.port);
  }

  printBanner(running, app, env, log);

  let resolveStopped: (reason: ServeStopReason) => void = () => {};
  const stopped = new Promise<ServeStopReason>((resolve) => {
    resolveStopped = resolve;
  });

  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  const onSignal = (signal: NodeJS.Signals): void => {
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
  log(`Local:    ${displayUrl}`);
  log(`Database: ${database}`);
  log('');
  log(`Web UI:   ${displayUrl}`);
  log('');

  if (!isLoopbackHost(running.host)) {
    log(
      `⚠ Bound to ${running.host} — NetPro is reachable from your network, not just ` +
        `this machine. The local-first default is 127.0.0.1; remote exposure is opt-in ` +
        `and full auth hardening lands in Phase 5.`
    );
    log('');
  }
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
