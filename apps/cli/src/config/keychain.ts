import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const scryptAsync = promisify(scrypt);

function getConfigDir(): string {
  const dir = join(homedir(), '.netpro');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function getMasterKey(): Promise<Buffer> {
  // Machine-specific key derivation. Swapping this for a real OS keychain
  // (keytar or a maintained successor) is tracked as follow-up work — see
  // the design spec's "CLI secrets" deviation.
  return (await scryptAsync(hostname(), 'netpro-salt-v1', 32)) as Buffer;
}

export class Keychain {
  private static get fallbackPath(): string {
    return join(getConfigDir(), 'credentials.enc');
  }

  static async set(key: string, value: string): Promise<void> {
    const store = await this.loadStore();
    store[key] = value;
    await this.saveStore(store);
  }

  static async get(key: string): Promise<string | null> {
    const store = await this.loadStore();
    return store[key] ?? null;
  }

  static async delete(key: string): Promise<void> {
    const store = await this.loadStore();
    delete store[key];
    await this.saveStore(store);
  }

  static async listKeys(): Promise<string[]> {
    return Object.keys(await this.loadStore());
  }

  private static async loadStore(): Promise<Record<string, string>> {
    if (!existsSync(this.fallbackPath)) return {};

    const masterKey = await getMasterKey();
    const encrypted = readFileSync(this.fallbackPath);

    const iv = encrypted.subarray(0, 16);
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(16, encrypted.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  }

  private static async saveStore(store: Record<string, string>): Promise<void> {
    const masterKey = await getMasterKey();
    const iv = randomBytes(16);

    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const plaintext = Buffer.from(JSON.stringify(store), 'utf-8');

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    writeFileSync(this.fallbackPath, Buffer.concat([iv, encrypted, authTag]), { mode: 0o600 });
  }
}
