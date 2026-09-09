import { requireMembership } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  listVaultKeys,
  vaultConfigured,
  PROVIDER_KEYS,
} from "@netpro/core/src/crypto";
import { canAtLeast } from "@netpro/core/src/workspaces";
import KeysClient from "./client";

export const metadata = { title: "Provider keys — NetPro" };
export const dynamic = "force-dynamic";
export default async function KeysPage() {
  const scope = await requireMembership();
  return (
    <KeysClient
      initialKeys={await listVaultKeys(conn, scope)}
      writable={
        vaultConfigured(process.env.ENCRYPTION_MASTER_KEY) &&
        canAtLeast(scope.role, "member")
      }
      admin={canAtLeast(scope.role, "admin")}
      slots={Object.keys(PROVIDER_KEYS)}
    />
  );
}
