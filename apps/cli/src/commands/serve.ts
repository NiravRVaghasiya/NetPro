import type { Command } from 'commander';
import type { ServeHandle } from '@netpro/server';

export interface ServeCommandOptions {
  host?: string;
  port?: string;
}

export type ServeDeps = {
  /** Environment overlay (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected server starter (tests). Defaults to @netpro/server's runServe. */
  start?: (options: {
    host?: string;
    port?: number;
    env?: NodeJS.ProcessEnv;
    signals?: NodeJS.Signals[];
  }) => Promise<ServeHandle>;
  /** Signals bound to graceful shutdown (tests pass [] or an AbortSignal-driven set). */
  signals?: NodeJS.Signals[];
};

/**
 * `netpro serve` — run the entire application on this machine.
 *
 * Resolution order for host/port (highest wins):
 *   1. --host / --port flags
 *   2. NETPRO_HOST / NETPRO_PORT environment
 *   3. ~/.netpro/config.toml [server]
 *   4. 127.0.0.1:3777 (the Phase 2 plan defaults)
 *
 * The command blocks until SIGINT/SIGTERM (or the injected stop signal) and
 * then shuts the server down gracefully. No Vercel, no cloud, no GitHub OAuth.
 */
export async function executeServe(
  options: ServeCommandOptions,
  deps: ServeDeps = {}
): Promise<ServeHandle> {
  // Imported lazily so commands that never start a server (--help, config)
  // don't load the HTTP/database stack — same pattern as openDb().
  const start =
    deps.start ??
    (await import('@netpro/server')).runServe;

  const port =
    options.port !== undefined && options.port.trim() !== ''
      ? Number(options.port)
      : undefined;
  // Port 0 is allowed: it binds an ephemeral port (embedders/tests and
  // `netpro serve --port 0` for "just give me a free port").
  if (port !== undefined && (!Number.isFinite(port) || port < 0 || port > 65535)) {
    throw new Error(`Invalid --port "${options.port}" — expected an integer between 0 and 65535.`);
  }

  return start({
    host: options.host,
    port,
    env: deps.env,
    signals: deps.signals,
  });
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Run the local NetPro server + Web UI (default 127.0.0.1:3777)')
    .option('--host <host>', 'Bind address (default 127.0.0.1 — remote exposure is opt-in)')
    .option('--port <port>', 'TCP port (default 3777)')
    .action(async (options: ServeCommandOptions) => {
      try {
        const handle = await executeServe(options);
        const stop = await handle.stopped;
        if (stop.reason === 'signal') {
          console.log(`\nReceived ${stop.signal}, shutting down…`);
        }
        console.log('NetPro server stopped.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ netpro serve failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
