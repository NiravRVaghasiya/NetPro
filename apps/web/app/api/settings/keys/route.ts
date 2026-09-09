import { conn } from "@/lib/db";
import { requireMembership } from "@/lib/authz";
import { crmJson, readCrmJson } from "@/lib/crm-request";
import { vaultErrorResponse } from "@/lib/vault";
import {
  listVaultKeys,
  saveVaultKey,
  removeVaultKey,
  vaultConfigured,
  VaultError,
} from "@netpro/core/src/crypto";

export async function GET(): Promise<Response> {
  try {
    const scope = await requireMembership();
    return crmJson({
      keys: await listVaultKeys(conn, scope),
      writable: vaultConfigured(process.env.ENCRYPTION_MASTER_KEY),
    });
  } catch (error) {
    return vaultErrorResponse(error);
  }
}

async function mutate(request: Request, remove: boolean): Promise<Response> {
  try {
    const scope = await requireMembership("member");
    const body = await readCrmJson(request);
    if (body.target !== "personal" && body.target !== "workspace")
      throw new VaultError(400, "Choose personal or workspace.");
    if (typeof body.keyName !== "string")
      throw new VaultError(400, "Choose a provider slot.");
    // Principal is derived only from the authenticated membership. Any supplied
    // userId/workspaceId is deliberately ignored.
    if (remove)
      await removeVaultKey(
        conn,
        scope,
        body.target,
        body.keyName,
        process.env.ENCRYPTION_MASTER_KEY,
      );
    else {
      if (typeof body.secret !== "string")
        throw new VaultError(400, "A credential is required.");
      await saveVaultKey(
        conn,
        scope,
        body.target,
        body.keyName,
        body.secret,
        process.env.ENCRYPTION_MASTER_KEY,
      );
    }
    return crmJson({ ok: true });
  } catch (error) {
    return vaultErrorResponse(error);
  }
}
export async function POST(request: Request) {
  return mutate(request, false);
}
export async function DELETE(request: Request) {
  return mutate(request, true);
}
