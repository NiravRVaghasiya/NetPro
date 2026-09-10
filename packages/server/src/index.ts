// packages/server — NetPro local-first HTTP server
//
// Phase 1: package skeleton that builds independently, imports @netpro/core
// and @netpro/db, and does not depend on Vercel or apps/web.
//
// Later phases add: netpro serve (Phase 2), full API (Phase 6), jobs (Phase 7),
// SSE (Phase 8), local auth (Phase 5).

export { loadConfig, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, type ServerConfig } from './config';
export { createApp, type NetProApp, type CreateAppOptions } from './app';
export { startServer, type RunningServer, type StartServerOptions } from './server';
export { resolveAuthContext, type AuthContext, type AuthMode } from './auth/index';
export { createJobRegistry, JobRegistry, type Job, type JobStatus, type JobType } from './jobs/index';
export { createEventBus, EventBus, type NetProEvent } from './events/index';
export { dispatch, type RouteContext } from './routes/index';
export { handleHealth, type HealthBody, type HealthDeps } from './routes/health';

import { createApp } from './app';
import { startServer } from './server';

/**
 * Programmatic entry: create app + listen.
 * Used by the CLI binary path and by `node packages/server/dist/index.js`.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Minimal flag parse — full CLI surface is Phase 2 (`netpro serve`).
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

NetPro local HTTP server (Phase 1 skeleton).
Default bind: 127.0.0.1:3777
`);
      return;
    }
  }

  const app = await createApp();
  const running = await startServer(app, { host, port });

  const dbPath =
    app.conn.dialect === 'sqlite'
      ? (process.env.DB_PATH ?? './netpro.db')
      : 'postgresql';

  console.log('NetPro server started');
  console.log('');
  console.log(`Local:    ${running.url}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Health:   ${running.url}/api/health`);
  console.log('');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    try {
      await running.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// Run when executed as a script (tsx / node dist/index.js), not when imported.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith(`${'/'}src/index.ts`) ||
    process.argv[1].endsWith(`${'/'}dist/index.js`) ||
    process.argv[1].endsWith('netpro-server') ||
    process.argv[1].includes('packages/server'));

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
