import { conn } from "./db";
import { requireMembership } from "./authz";
import {
  PROVIDER_KEYS,
  resolveVaultKey,
  listVaultKeys,
  vaultConfigured,
  VaultError,
  type ProviderKey,
} from "@netpro/core/src/crypto";
import { CrmRequestError, crmJson } from "./crm-request";

/** Never accepts a workspace/user ID from HTTP input. No caching across users. */
export async function providerEnvironment(
  keys: readonly ProviderKey[],
): Promise<NodeJS.ProcessEnv> {
  const scope = await requireMembership("member");
  const env = { ...process.env };
  for (const name of keys) {
    const secret = await resolveVaultKey(conn, scope, name);
    if (secret) env[PROVIDER_KEYS[name]] = secret;
  }
  return env;
}

export function vaultErrorResponse(error: unknown): Response {
  if (error instanceof VaultError || error instanceof CrmRequestError)
    return crmJson({ error: error.message }, error.status);
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? error.status
      : undefined;
  if (status === 401 || status === 403)
    return crmJson(
      { error: status === 401 ? "Unauthorized" : "Forbidden" },
      status,
    );
  // DB errors can contain query parameters (ciphertext); never log or echo them.
  return crmJson({ error: "Credential operation failed." }, 500);
}

/** Presence-only config for rendering capability flags; never decrypts/marks use. */
export async function providerStatusEnvironment(
  keys: readonly ProviderKey[],
): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (!vaultConfigured(env.ENCRYPTION_MASTER_KEY)) return env;
  const scope = await requireMembership();
  const stored = await listVaultKeys(conn, scope);
  for (const name of keys) {
    if (stored.some((row) => row.keyName === name))
      env[PROVIDER_KEYS[name]] = "configured-in-vault";
  }
  return env;
}
