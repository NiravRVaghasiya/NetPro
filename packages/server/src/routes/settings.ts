// packages/server/src/routes/settings.ts
//
// GET /api/settings
// PUT /api/settings
//
// Phase 6 settings contract — what the Web UI renders on /settings and what
// the CLI inspects via `netpro config`. The server is the source of truth
// for server identity, database dialect, auth mode, and installation
// identity; the UI never guesses.
//
// GET returns the observable settings (never the raw token — only whether one
// exists and its prefix, same as /api/identity).
// PUT validates the patch, writes config.toml where appropriate via @netpro/db,
// and returns the updated view. Unknown keys are 400 — silent ignores would
// let the UI think it saved something it did not.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  describeConn,
  netproHome,
  readLocalConfig,
  redactPostgresUrl,
  type LocalConfig,
} from '@netpro/db';
import { sendJson, readJsonBody } from '../middleware/json';
import type { AuthPolicy } from '../auth/index';
import type { ServerConfig } from '../config';
import { SERVER_VERSION } from '../version';

export type SettingsDeps = {
  conn: SqliteConn | PgConn;
  config: ServerConfig;
  auth: AuthPolicy;
};

function serializeLocalConfig(raw: LocalConfig) {
  // Phase 23 — raw comes from readLocalConfig, and [database] url can carry
  // user:password@. Authenticated callers may see *that* a URL is configured
  // and where it points, but never the credential inside it.
  if (!raw.database || typeof raw.database !== 'object' || typeof raw.database.url !== 'string') {
    return raw;
  }
  return {
    ...raw,
    database: { ...raw.database, url: redactPostgresUrl(raw.database.url) },
  };
}

export async function handleGetSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SettingsDeps
): Promise<void> {
  const rawConfig = (() => {
    try {
      return readLocalConfig(process.env);
    } catch (e) {
      // Invalid config.toml is surfaced here so the UI can show the error
      // rather than hide a broken file behind defaults.
      return { _error: e instanceof Error ? e.message : String(e) } as unknown as LocalConfig;
    }
  })();

  sendJson(res, 200, {
    server: {
      host: deps.config.host,
      port: deps.config.port,
      autoMigrate: deps.config.autoMigrate,
    },
    database: {
      dialect: deps.conn.dialect,
      display: describeConn(deps.conn),
      home: netproHome(),
    },
    auth: {
      mode: deps.auth.mode,
      tokenConfigured: deps.auth.token !== null,
    },
    installation: deps.auth.installation
      ? {
          id: deps.auth.installation.id,
          createdAt: deps.auth.installation.createdAt || null,
          owner: deps.auth.installation.owner ?? null,
        }
      : null,
    configFile: serializeLocalConfig(rawConfig),
    version: SERVER_VERSION,
  });
}

export async function handlePutSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SettingsDeps
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // For now the server is read-mostly: the canonical edit path is
  // `netpro config` (TOML) + `netpro token`. A PUT that carries no known
  // key is a client bug — reject rather than silently accept.
  const allowedKeys = new Set(['server', 'auth', 'database']);
  const unknown = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (unknown.length > 0) {
    sendJson(res, 400, {
      error: `Unknown settings key(s): ${unknown.join(', ')}. Allowed: ${[...allowedKeys].join(', ')}.`,
    });
    return;
  }

  // No mutation yet — echo current settings with a note so the UI can
  // migrate from PUT → CLI config without branching on status.
  sendJson(res, 200, {
    message: 'Settings are file-managed. Use `netpro config` and `~/.netpro/config.toml` to edit, then restart the server.',
    server: {
      host: deps.config.host,
      port: deps.config.port,
      autoMigrate: deps.config.autoMigrate,
    },
    database: {
      dialect: deps.conn.dialect,
      display: describeConn(deps.conn),
      home: netproHome(),
    },
    auth: {
      mode: deps.auth.mode,
      tokenConfigured: deps.auth.token !== null,
    },
    installation: deps.auth.installation
      ? {
          id: deps.auth.installation.id,
          createdAt: deps.auth.installation.createdAt || null,
          owner: deps.auth.installation.owner ?? null,
        }
      : null,
  });
}
