// packages/server/src/routes/credentials.ts
//
// GET    /api/credentials
// PUT    /api/credentials/:provider
// POST   /api/credentials/:provider/test
// DELETE /api/credentials/:provider
//
// The server side of "paste an API key": a thin HTTP view over the encrypted
// vault (`@netpro/core` crypto/vault) and the provider-key checks
// (`@netpro/core` crypto/provider-keys). The Web UI's "Connect an API" card
// and any future CLI surface share this one implementation.
//
// Security posture (non-negotiable here):
//   * Raw keys never leave in a response: GET lists masked metadata
//     (`lastFour`, `updatedAt`) and PUT/DELETE echo the same, never the key.
//   * Keys are never logged, never interpolated into an error, and never
//     read from a URL — PUT takes `{ apiKey }` in the JSON body only.
//   * Writes go to the AES-256-GCM vault via `saveVaultKey` (workspace
//     target, so one stored key serves the install); without
//     `ENCRYPTION_MASTER_KEY` the vault is read-only and writes fail 503
//     with setup guidance instead of degrading to plaintext anywhere.
//   * Remote validation happens *before* saving: a rejected or unreachable
//     check leaves the stored key untouched ("Your key was not changed").
//   * There is no provider guessing and no fabricated validation —
//     providers without a safe documented check are stored honestly as
//     "saved but not remotely validated".

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  listVaultKeys,
  removeVaultKey,
  resolveVaultKey,
  saveVaultKey,
} from '@netpro/core/src/crypto/vault';
import { vaultConfigured, VaultError } from '@netpro/core/src/crypto/key-vault';
import {
  checkApiKeyFormat,
  connectableProvider,
  KEY_TEST_MESSAGES,
  listConnectableProviders,
  providerForVaultSlot,
  testProviderKey,
} from '@netpro/core/src/crypto/provider-keys';
import { PROVIDER_CATALOG } from '@netpro/core/src/providers';
import { bootstrapScope } from '@netpro/core/src/workspaces/scope';
import { sendJson, readJsonBody } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type CredentialsDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

type CredentialSource = 'vault' | 'env' | 'none';

export interface CredentialStatus {
  id: string;
  label: string;
  category: string;
  purpose: string;
  configured: boolean;
  source: CredentialSource;
  /** Last 4 chars of the vault-stored key — the only key fragment ever sent. */
  lastFour: string | null;
  updatedAt: string | null;
  remotelyValidatable: boolean;
  validationNote: string;
}

const VAULT_SETUP_MESSAGE =
  'To store API keys, set ENCRYPTION_MASTER_KEY (at least 32 characters) on the process running `netpro serve` and restart it.';

function vaultMaster(): string | undefined {
  return process.env.ENCRYPTION_MASTER_KEY;
}

/** Presence of any of the provider's env vars (never the values). */
function envConfigured(envVars: readonly string[]): boolean {
  return envVars.some((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

async function credentialStatus(
  deps: CredentialsDeps,
  providerId: string
): Promise<CredentialStatus> {
  const provider = connectableProvider(providerId);
  const scope = bootstrapScope();
  let lastFour: string | null = null;
  let updatedAt: string | null = null;
  let inVault = false;
  try {
    // Metadata-only: listVaultKeys never selects ciphertext.
    const rows = await listVaultKeys(deps.conn, scope);
    const row = rows.find((r) => r.keyName === provider.vaultSlot);
    if (row) {
      inVault = true;
      lastFour = row.lastFour ?? null;
      updatedAt = row.updatedAt ?? null;
    }
  } catch {
    // A vault read failure degrades to env-only rather than failing the
    // whole listing — the UI still shows what the process holds.
  }
  const inEnv = envConfigured(provider.envVars);
  const source: CredentialSource = inVault ? 'vault' : inEnv ? 'env' : 'none';
  return {
    id: provider.id,
    label: provider.label,
    category: provider.category,
    purpose: provider.purpose,
    configured: inVault || inEnv,
    source,
    lastFour,
    updatedAt,
    remotelyValidatable: provider.remotelyValidatable,
    validationNote: provider.validationNote,
  };
}

function vaultErrorStatus(error: unknown): number {
  if (error instanceof VaultError) return error.status;
  return 500;
}

export async function handleListCredentials(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CredentialsDeps
): Promise<void> {
  const providers: CredentialStatus[] = [];
  for (const descriptor of listConnectableProviders()) {
    providers.push(await credentialStatus(deps, descriptor.id));
  }
  sendJson(res, 200, {
    vault: { available: vaultConfigured(vaultMaster()) },
    providers,
  });
}

export async function handleSaveCredential(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CredentialsDeps,
  providerId: string
): Promise<void> {
  let provider;
  try {
    provider = connectableProvider(providerId);
  } catch (error) {
    sendJson(res, vaultErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: 'unknown_provider',
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';

  // 1. Local format check — instant, offline, no key material in the error.
  const format = checkApiKeyFormat(provider.id, apiKey);
  if (!format.ok) {
    sendJson(res, 400, { error: format.error, code: 'invalid_key' });
    return;
  }

  // 2. The vault must be writable — checked before any network call.
  const master = vaultMaster();
  if (!vaultConfigured(master)) {
    sendJson(res, 503, { error: VAULT_SETUP_MESSAGE, code: 'vault_unavailable' });
    return;
  }

  // 3. Remote validation before saving — a failure leaves the stored key
  // untouched. Providers without a safe check skip honestly to step 4.
  let validated = false;
  if (provider.remotelyValidatable) {
    const outcome = await testProviderKey(provider.id, apiKey.trim(), {
      openaiBaseUrl: process.env.OPENAI_BASE_URL,
    });
    if (outcome.status === 'invalid') {
      sendJson(res, 422, { error: outcome.message, code: 'validation_failed' });
      return;
    }
    if (outcome.status === 'unreachable') {
      sendJson(res, 502, { error: outcome.message, code: 'provider_unreachable' });
      return;
    }
    validated = outcome.status === 'valid';
  }

  // 4. Encrypted save (workspace target: one stored key serves the install).
  try {
    await saveVaultKey(deps.conn, bootstrapScope(), 'workspace', provider.vaultSlot, apiKey.trim(), master);
  } catch (error) {
    sendJson(res, vaultErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: 'vault_error',
    });
    return;
  }

  sendJson(res, 200, {
    provider: await credentialStatus(deps, provider.id),
    validated,
    warnings: format.warnings,
  });
}

export async function handleTestCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CredentialsDeps,
  providerId: string
): Promise<void> {
  let provider;
  try {
    provider = connectableProvider(providerId);
  } catch (error) {
    sendJson(res, vaultErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: 'unknown_provider',
    });
    return;
  }

  const status = await credentialStatus(deps, provider.id);
  if (!status.configured) {
    sendJson(res, 404, {
      error: `No API key is configured for ${provider.label} yet.`,
      code: 'not_configured',
    });
    return;
  }

  if (!provider.remotelyValidatable) {
    sendJson(res, 200, {
      provider: provider.id,
      status: 'unsupported',
      message: KEY_TEST_MESSAGES.unsupported(provider.label),
    });
    return;
  }

  // A vault-stored key that cannot be decrypted (locked vault) must say so —
  // not masquerade as "no key configured".
  if (status.source === 'vault' && !vaultConfigured(vaultMaster())) {
    sendJson(res, 503, {
      error:
        `The stored ${provider.label} key can't be read because the vault is locked. ` +
        VAULT_SETUP_MESSAGE,
      code: 'vault_unavailable',
    });
    return;
  }

  // Server-side resolution only — the key is used for the check and never
  // returned. Falls back to the process env when no vault row exists. A null
  // here after `configured` was true means the key vanished mid-request —
  // report it as unconfigured rather than testing thin air.
  let apiKey: string | null;
  try {
    apiKey = await resolveVaultKey(deps.conn, bootstrapScope(), provider.vaultSlot);
  } catch {
    apiKey = null;
  }
  if (!apiKey) {
    sendJson(res, 404, {
      error: `No API key is configured for ${provider.label} yet.`,
      code: 'not_configured',
    });
    return;
  }

  const outcome = await testProviderKey(provider.id, apiKey, {
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
  });
  // The request succeeded — the outcome is data, so this is always 200 and
  // the UI branches on `status`, never on HTTP codes.
  sendJson(res, 200, { provider: provider.id, status: outcome.status, message: outcome.message });
}

export async function handleDeleteCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CredentialsDeps,
  providerId: string
): Promise<void> {
  let provider;
  try {
    provider = connectableProvider(providerId);
  } catch (error) {
    sendJson(res, vaultErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: 'unknown_provider',
    });
    return;
  }

  if (!vaultConfigured(vaultMaster())) {
    sendJson(res, 503, { error: VAULT_SETUP_MESSAGE, code: 'vault_unavailable' });
    return;
  }

  try {
    await removeVaultKey(deps.conn, bootstrapScope(), 'workspace', provider.vaultSlot, vaultMaster());
  } catch (error) {
    sendJson(res, vaultErrorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
      code: 'vault_error',
    });
    return;
  }

  const after = await credentialStatus(deps, provider.id);
  const descriptor = PROVIDER_CATALOG.find((d) => d.id === provider.id);
  const envName = descriptor?.envVars[0] ?? 'environment variable';
  sendJson(res, 200, {
    provider: after,
    removed: true,
    message:
      after.configured && after.source === 'env'
        ? `Removed the stored key. ${envName} is still set, so ${provider.label} stays configured.`
        : `Removed the stored ${provider.label} key.`,
  });
}

/** Names of the vault rows currently held, for provider-status merging. */
export async function vaultPresence(deps: CredentialsDeps): Promise<Record<string, string>> {
  try {
    const rows = await listVaultKeys(deps.conn, bootstrapScope());
    const presence: Record<string, string> = {};
    for (const row of rows) {
      // Only provider slots feed the status snapshot — plugin credentials
      // are invisible to the provider strips by design.
      if (providerForVaultSlot(row.keyName)) presence[row.keyName] = 'present';
    }
    return presence;
  } catch {
    return {};
  }
}
