// packages/server/src/server.ts
//
// HTTP lifecycle: listen, shutdown. Uses Node's built-in `node:http` only —
// no Express/Fastify/Hono, no serverless-platform adapters, no Next.js.

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { NetProApp } from './app';

export type RunningServer = {
  app: NetProApp;
  http: HttpServer;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type StartServerOptions = {
  host?: string;
  port?: number;
};

/**
 * Bind `app.handler` to a TCP port and start accepting connections.
 *
 * Default host is the app config host (127.0.0.1). Port 0 is allowed for
 * tests (ephemeral).
 */
export async function startServer(
  app: NetProApp,
  options: StartServerOptions = {}
): Promise<RunningServer> {
  const host = options.host ?? app.config.host;
  const port = options.port ?? app.config.port;

  const http = createHttpServer(app.handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      http.off('error', onError);
      reject(error);
    };
    http.once('error', onError);
    http.listen(port, host, () => {
      http.off('error', onError);
      resolve();
    });
  });

  const address = http.address();
  const boundPort =
    address && typeof address === 'object' ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
    await app.close();
  };

  return { app, http, host, port: boundPort, url, close };
}
