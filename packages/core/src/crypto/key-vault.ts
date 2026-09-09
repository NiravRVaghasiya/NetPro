import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export function vaultConfigured(master: string | undefined): master is string {
  return typeof master === "string" && master.trim().length >= 32;
}

function derive(master: string | undefined, principal: string): Buffer {
  if (!vaultConfigured(master))
    throw new VaultError(
      503,
      "Key vault is read-only: configure ENCRYPTION_MASTER_KEY (at least 32 characters).",
    );
  return createHash("sha256")
    .update(`${master}:${principal}:netpro-key-vault-v1`)
    .digest();
}

// JSON tuples avoid ambiguous workspace/user/name concatenations. The slot is
// authenticated as well as the principal, so swapping DB ciphertexts fails.
export function vaultPrincipal(
  workspaceId: string,
  userId: string | null,
  keyName: string,
): string {
  return JSON.stringify([workspaceId, userId, keyName]);
}

export function encryptKey(
  secret: string,
  master: string | undefined,
  principal: string,
): string {
  const key = derive(master, principal);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}

export function decryptKey(
  value: string,
  master: string | undefined,
  principal: string,
): string {
  const key = derive(master, principal);
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 29) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never attach the original exception, ciphertext, principal or secret.
    throw new VaultError(
      503,
      "Unable to decrypt vault credential. Restore the master key or replace the credential.",
    );
  }
}
