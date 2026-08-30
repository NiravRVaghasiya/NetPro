# NetPro — Security & Auth Architecture

> How to protect user data, manage secrets, authenticate sessions, and harden the system against abuse — across CLI, web app, and self-hosted deployments.

---

## Security Philosophy

```
┌─────────────────────────────────────────────────────────────┐
│                    SECURITY PRINCIPLES                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. ZERO TRUST         → Verify every request, every time  │
│  2. LOCAL-FIRST        → Secrets never leave the device    │
│  3. BYO-KEY            → We never hold user's API keys     │
│  4. MINIMAL PII        → Only store what's explicitly      │
│                           imported by the user              │
│  5. ENCRYPT AT REST    → SQLCipher (CLI) / RLS (Postgres)  │
│  6. AUDIT EVERYTHING   → Every action logged, tamper-proof │
│  7. FAIL CLOSED        → On error, deny access             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1: Authentication

---

### 1.1 Auth Strategy Overview

| Surface | Auth Method | Session Duration | Token Storage |
|---------|------------|-----------------|---------------|
| **Web App** | Auth.js (NextAuth v5) with OAuth | 30 days (refresh) | HttpOnly secure cookie |
| **CLI** | Device token (OAuth device flow) | Until revoked | OS keychain |
| **API Routes** | Bearer token (JWT) | 1 hour (access) | Memory only |
| **Public Card** | No auth (public by design) | N/A | N/A |
| **Sync API** | Mutual TLS or signed requests | Per-request | OS keychain (CLI) |

---

### 1.2 Web App Authentication (Auth.js v5)

```typescript
// apps/web/lib/auth.ts
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@netpro/db';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  
  providers: [
    // OAuth providers — no password management needed
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // Magic link — passwordless
    Resend({
      apiKey: process.env.RESEND_API_KEY!,
      from: 'NetPro <auth@netpro.dev>',
    }),
  ],
  
  session: {
    strategy: 'jwt',           // Stateless — no session DB table needed
    maxAge: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60,   // Refresh every 24h
  },
  
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        token.userId = user.id;
        token.provider = account?.provider;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId as string;
      return session;
    },
  },
  
  pages: {
    signIn: '/login',
    error: '/login?error=true',
    verifyRequest: '/login/verify', // Magic link sent page
  },
  
  // Security hardening
  cookies: {
    sessionToken: {
      name: '__Secure-netpro.session',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true, // HTTPS only in production
      },
    },
  },
});
```

**Auth flow diagram:**

```
┌──────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────┐
│  User    │────▶│  /login page │────▶│ OAuth Flow  │────▶│  Callback  │
│ (browser)│     │  (choose     │     │ (GitHub/    │     │  /api/auth │
│          │◀────│   provider)  │◀────│  Google)    │◀────│  /callback │
└──────────┘     └──────────────┘     └─────────────┘     └────────────┘
     │                                                           │
     │  Set HttpOnly cookie                                      │
     │  (__Secure-netpro.session = JWT)                         │
     │◀──────────────────────────────────────────────────────────┘
     │
     │  Subsequent requests include cookie automatically
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Middleware (apps/web/middleware.ts)                                  │
│  • Verify JWT signature                                              │
│  • Check expiration                                                  │
│  • Attach user context to request                                    │
│  • Redirect unauthenticated to /login                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 1.3 CLI Authentication (OAuth Device Flow)

The CLI uses **OAuth 2.0 Device Authorization Grant** (RFC 8628) — the same flow used by GitHub CLI, Vercel CLI, etc.

```typescript
// apps/cli/src/auth/device-flow.ts
import open from 'open';
import { Keychain } from '../config/keychain';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function loginViaBrowser(): Promise<string> {
  // Step 1: Request device code from NetPro auth server
  const deviceCode = await requestDeviceCode();
  
  console.log(`\n🔐 Open this URL in your browser:\n`);
  console.log(`   ${deviceCode.verification_uri}\n`);
  console.log(`   Enter code: ${deviceCode.user_code}\n`);
  
  // Attempt to open browser automatically
  await open(deviceCode.verification_uri);
  
  // Step 2: Poll for token (user completes auth in browser)
  const token = await pollForToken(deviceCode);
  
  // Step 3: Store in OS keychain
  await Keychain.set('netpro-auth-token', token.access_token);
  await Keychain.set('netpro-refresh-token', token.refresh_token);
  
  console.log(`✓ Authenticated successfully!\n`);
  return token.access_token;
}

async function pollForToken(deviceCode: DeviceCodeResponse) {
  const deadline = Date.now() + deviceCode.expires_in * 1000;
  
  while (Date.now() < deadline) {
    await sleep(deviceCode.interval * 1000);
    
    const response = await fetch(`${AUTH_SERVER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    });
    
    if (response.ok) return response.json();
    
    const error = await response.json();
    if (error.error === 'authorization_pending') continue;
    if (error.error === 'slow_down') { await sleep(5000); continue; }
    throw new Error(`Auth failed: ${error.error_description}`);
  }
  
  throw new Error('Authentication timed out');
}
```

**Offline mode:** When no auth token exists or user opts out of cloud sync, the CLI operates fully locally with SQLite — no authentication required. Auth is only needed for:
- Syncing data with the web app
- Using hosted enrichment APIs
- Team/shared features

---

### 1.4 API Route Protection (Middleware)

```typescript
// apps/web/middleware.ts
import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Routes that require authentication
const PROTECTED_ROUTES = ['/dashboard', '/search', '/outreach', '/contacts', '/settings'];
const API_ROUTES = ['/api/search', '/api/enrich', '/api/outreach', '/api/analytics'];
const PUBLIC_ROUTES = ['/login', '/card', '/api/auth', '/api/health'];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  
  // Public routes — no auth needed
  if (PUBLIC_ROUTES.some(route => pathname.startsWith(route))) {
    return NextResponse.next();
  }
  
  // API routes — verify JWT
  if (API_ROUTES.some(route => pathname.startsWith(route))) {
    if (!req.auth?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Rate limiting check
    const rateLimitResult = checkRateLimit(req);
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded', retryAfter: rateLimitResult.retryAfter },
        { status: 429, headers: { 'Retry-After': String(rateLimitResult.retryAfter) } }
      );
    }
    
    return NextResponse.next();
  }
  
  // Protected routes — redirect to login
  if (PROTECTED_ROUTES.some(route => pathname.startsWith(route))) {
    if (!req.auth?.user) {
      return NextResponse.redirect(new URL('/login', req.url));
    }
  }
  
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

---

## Part 2: Secrets Management

---

### 2.1 Secret Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SECRET STORAGE BY SURFACE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  CLI (Local)                                                        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  macOS: Keychain Access (via security CLI)                    │  │
│  │  Linux: libsecret / Secret Service API (GNOME Keyring/KWallet│  │
│  │  Windows: Windows Credential Manager (via wincred)            │  │
│  │  Fallback: Encrypted file (~/.netpro/credentials.enc)         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Web App (Serverless)                                               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Vercel: Environment Variables (encrypted at rest, per-env)   │  │
│  │  User API keys: Encrypted in DB (AES-256-GCM, per-user key)  │  │
│  │  Session secrets: HttpOnly cookies (never exposed to JS)      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Self-Hosted (Docker)                                               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Docker secrets / .env file (excluded from VCS)               │  │
│  │  Optional: HashiCorp Vault, AWS SSM Parameter Store           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 CLI Keychain Integration

```typescript
// apps/cli/src/config/keychain.ts
import keytar from 'keytar';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SERVICE_NAME = 'netpro';
const scryptAsync = promisify(scrypt);

export class Keychain {
  private static fallbackPath = join(getConfigDir(), 'credentials.enc');
  
  /**
   * Store a secret in the OS keychain (preferred) or encrypted file (fallback)
   */
  static async set(key: string, value: string): Promise<void> {
    try {
      // Try OS keychain first
      await keytar.setPassword(SERVICE_NAME, key, value);
    } catch {
      // Fallback: encrypted JSON file
      await this.setFallback(key, value);
    }
  }
  
  /**
   * Retrieve a secret from the OS keychain or encrypted file
   */
  static async get(key: string): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, key);
    } catch {
      return this.getFallback(key);
    }
  }
  
  /**
   * Delete a secret
   */
  static async delete(key: string): Promise<void> {
    try {
      await keytar.deletePassword(SERVICE_NAME, key);
    } catch {
      await this.deleteFallback(key);
    }
  }
  
  /**
   * List all stored keys (without values)
   */
  static async listKeys(): Promise<string[]> {
    try {
      const creds = await keytar.findCredentials(SERVICE_NAME);
      return creds.map(c => c.account);
    } catch {
      return this.listFallbackKeys();
    }
  }
  
  // ─── Encrypted file fallback ───
  // Used when OS keychain is unavailable (headless Linux, CI, etc.)
  
  private static async setFallback(key: string, value: string): Promise<void> {
    const store = await this.loadFallbackStore();
    store[key] = value;
    await this.saveFallbackStore(store);
  }
  
  private static async getFallback(key: string): Promise<string | null> {
    const store = await this.loadFallbackStore();
    return store[key] ?? null;
  }
  
  private static async loadFallbackStore(): Promise<Record<string, string>> {
    if (!existsSync(this.fallbackPath)) return {};
    
    const masterKey = await this.getMasterKey();
    const encrypted = readFileSync(this.fallbackPath);
    
    // Format: [16 bytes IV][encrypted data][16 bytes auth tag]
    const iv = encrypted.subarray(0, 16);
    const authTag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(16, encrypted.length - 16);
    
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  }
  
  private static async saveFallbackStore(store: Record<string, string>): Promise<void> {
    const masterKey = await this.getMasterKey();
    const iv = randomBytes(16);
    
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const plaintext = Buffer.from(JSON.stringify(store), 'utf-8');
    
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Write: IV + ciphertext + auth tag
    writeFileSync(this.fallbackPath, Buffer.concat([iv, encrypted, authTag]), { mode: 0o600 });
  }
  
  private static async getMasterKey(): Promise<Buffer> {
    // Derive from machine-specific identifier + user password
    // On first run, user sets a master password (or we use machine ID)
    const machineId = getMachineId(); // Unique per device
    return (await scryptAsync(machineId, 'netpro-salt-v1', 32)) as Buffer;
  }
}
```

---

### 2.3 User API Key Encryption (Web App)

```typescript
// packages/core/src/crypto/key-vault.ts
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a user's API key before storing in the database.
 * Each user has a unique encryption key derived from their userId + app secret.
 */
export class KeyVault {
  private masterSecret: string;
  
  constructor() {
    this.masterSecret = process.env.ENCRYPTION_MASTER_KEY!;
    if (!this.masterSecret || this.masterSecret.length < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must be at least 32 characters');
    }
  }
  
  /**
   * Derive a per-user encryption key.
   * Even if DB is compromised, attacker needs master secret to decrypt.
   */
  private deriveKey(userId: string): Buffer {
    return createHash('sha256')
      .update(`${this.masterSecret}:${userId}:netpro-key-vault-v1`)
      .digest();
  }
  
  /**
   * Encrypt an API key for storage
   * Returns: base64(iv + ciphertext + authTag)
   */
  encrypt(userId: string, plaintext: string): string {
    const key = this.deriveKey(userId);
    const iv = randomBytes(IV_LENGTH);
    
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    
    // Concatenate: IV (12) + ciphertext + auth tag (16)
    const combined = Buffer.concat([iv, encrypted, authTag]);
    return combined.toString('base64');
  }
  
  /**
   * Decrypt a stored API key
   */
  decrypt(userId: string, encryptedBase64: string): string {
    const key = this.deriveKey(userId);
    const combined = Buffer.from(encryptedBase64, 'base64');
    
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);
    
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');
  }
  
  /**
   * Rotate the master key: re-encrypt all stored keys
   */
  async rotateMasterKey(newMasterSecret: string, db: Database): Promise<void> {
    const allKeys = await db.select().from(userApiKeys);
    
    const newVault = new KeyVault();
    // Temporarily override master secret for new encryption
    (newVault as any).masterSecret = newMasterSecret;
    
    for (const record of allKeys) {
      const decrypted = this.decrypt(record.userId, record.encryptedKey);
      const reEncrypted = newVault.encrypt(record.userId, decrypted);
      
      await db.update(userApiKeys)
        .set({ encryptedKey: reEncrypted, rotatedAt: new Date().toISOString() })
        .where(eq(userApiKeys.id, record.id));
    }
  }
}

// ─── Database schema for user API keys ───
export const userApiKeys = sqliteTable('user_api_keys', {
  id:           text('id').primaryKey(),
  userId:       text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  
  provider:     text('provider').notNull(),    // 'openai' | 'anthropic' | 'hunter' | 'pdl'
  keyName:      text('key_name'),              // User-friendly label
  encryptedKey: text('encrypted_key').notNull(), // AES-256-GCM encrypted
  
  // Metadata (never contains the actual key)
  keyPrefix:    text('key_prefix'),            // "sk-...abc" (first 4 + last 3 chars)
  lastUsedAt:   text('last_used_at'),
  createdAt:    text('created_at').notNull(),
  rotatedAt:    text('rotated_at'),
});
```

---

### 2.4 API Key Flow (BYO-Key Pattern)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     BYO-KEY FLOW (Web App)                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User adds OpenAI key in /settings                                       │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────┐                     │
│  │ Client-side: Key input (type=password)          │                     │
│  │ • Key never stored in browser storage           │                     │
│  │ • Sent directly to API via HTTPS POST           │                     │
│  └─────────────────────┬───────────────────────────┘                     │
│                        │ HTTPS (TLS 1.3)                                 │
│                        ▼                                                  │
│  ┌─────────────────────────────────────────────────┐                     │
│  │ API Route: POST /api/settings/keys              │                     │
│  │ 1. Validate key format (prefix check)           │                     │
│  │ 2. Test key with provider (dry-run API call)    │                     │
│  │ 3. Encrypt with KeyVault.encrypt(userId, key)   │                     │
│  │ 4. Store encrypted blob in user_api_keys table  │                     │
│  │ 5. Store keyPrefix for display ("sk-...xyz")    │                     │
│  └─────────────────────┬───────────────────────────┘                     │
│                        │                                                  │
│                        ▼                                                  │
│  ┌─────────────────────────────────────────────────┐                     │
│  │ Usage (e.g. AI outreach):                       │                     │
│  │ 1. Load encrypted key from DB                   │                     │
│  │ 2. Decrypt in-memory: KeyVault.decrypt(...)     │                     │
│  │ 3. Pass to provider SDK (OpenAI, Anthropic)     │                     │
│  │ 4. Key lives in memory only during request      │                     │
│  │ 5. Never logged, never cached, never serialized │                     │
│  └─────────────────────────────────────────────────┘                     │
│                                                                          │
│  GUARANTEES:                                                             │
│  • Key encrypted at rest (AES-256-GCM)                                   │
│  • Per-user encryption key (DB breach alone is insufficient)             │
│  • Key only decrypted in serverless function memory (ephemeral)          │
│  • Key prefix shown in UI for identification (never full key)            │
│  • User can revoke/delete at any time → hard delete from DB              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Part 3: Data Encryption

---

### 3.1 Encryption at Rest

| Layer | Method | Key Management |
|-------|--------|----------------|
| **CLI SQLite** | SQLCipher (AES-256-CBC, page-level) | User passphrase → PBKDF2 → key |
| **Web Postgres** | Supabase TDE (Transparent Data Encryption) | Managed by Supabase |
| **User API keys** | AES-256-GCM (application-level) | Master key in env + per-user derivation |
| **Backups** | AES-256-GCM on export file | User-provided password or derived key |
| **Sensitive fields** | Column-level encryption (selective) | Per-user key |

```typescript
// apps/cli/src/db/encrypted.ts
import Database from 'better-sqlite3';

export function openEncryptedDB(path: string, passphrase: string): Database.Database {
  const db = new Database(path);
  
  // SQLCipher configuration
  db.pragma(`key = '${passphrase}'`);
  db.pragma('cipher_page_size = 4096');
  db.pragma('kdf_iter = 256000');             // PBKDF2 iterations (slow = secure)
  db.pragma('cipher_hmac_algorithm = HMAC_SHA512');
  db.pragma('cipher_kdf_algorithm = PBKDF2_HMAC_SHA512');
  
  // Verify DB is accessible (will throw if passphrase is wrong)
  db.pragma('integrity_check');
  
  return db;
}

// First-time setup: user chooses passphrase or auto-generate
export async function initializeDB(path: string): Promise<Database.Database> {
  const passphrase = await promptPassphrase();
  // Or auto-generate and store in OS keychain:
  // const passphrase = randomBytes(32).toString('hex');
  // await Keychain.set('netpro-db-passphrase', passphrase);
  
  const db = openEncryptedDB(path, passphrase);
  
  // Run migrations
  await runMigrations(db);
  
  return db;
}
```

---

### 3.2 Encryption in Transit

```typescript
// packages/core/src/http/secure-client.ts

/**
 * Secure HTTP client for all external API calls.
 * Enforces TLS, certificate pinning (optional), and request signing.
 */
export class SecureHTTPClient {
  private readonly baseHeaders: Record<string, string>;
  
  constructor(private config: {
    timeout?: number;
    retries?: number;
    certificatePinning?: boolean;
  }) {
    this.baseHeaders = {
      'User-Agent': `NetPro/${VERSION}`,
      'Accept': 'application/json',
    };
  }
  
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    // Enforce HTTPS
    if (!url.startsWith('https://') && !url.startsWith('http://localhost')) {
      throw new SecurityError('All external requests must use HTTPS');
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout ?? 30000);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.baseHeaders,
          ...options.headers,
        },
      });
      
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

---

### 3.3 Selective Column Encryption

For highly sensitive fields (email, phone) that need to be searchable:

```typescript
// packages/core/src/crypto/field-encryption.ts

/**
 * Deterministic encryption for searchable fields.
 * Trade-off: Same plaintext → same ciphertext (enables equality search)
 * but weaker than randomized encryption.
 * 
 * Use for: email lookups ("find contact by email")
 * DO NOT use for: fields needing semantic search
 */
export class DeterministicEncryption {
  private key: Buffer;
  
  constructor(masterKey: string, userId: string) {
    this.key = createHash('sha256')
      .update(`${masterKey}:${userId}:deterministic-v1`)
      .digest();
  }
  
  encrypt(plaintext: string): string {
    // SIV (Synthetic IV) mode — deterministic but authenticated
    const iv = createHash('sha256')
      .update(`${this.key.toString('hex')}:${plaintext}`)
      .digest()
      .subarray(0, 12);
    
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([iv, encrypted, authTag]).toString('base64');
  }
  
  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(buf.length - 16);
    const encrypted = buf.subarray(12, buf.length - 16);
    
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
  }
  
  /**
   * Generate a blind index for searchable encryption.
   * Stores HMAC hash alongside encrypted field for lookup.
   */
  blindIndex(plaintext: string): string {
    return createHmac('sha256', this.key)
      .update(plaintext.toLowerCase().trim())
      .digest('hex')
      .substring(0, 32); // Truncate to reduce leakage
  }
}

// Usage in schema:
// contacts.email_encrypted = DeterministicEncryption.encrypt(email)
// contacts.email_blind_index = DeterministicEncryption.blindIndex(email)
// 
// Search: WHERE email_blind_index = blindIndex(searchEmail)
```

---

## Part 4: Rate Limiting & Abuse Prevention

---

### 4.1 Multi-Layer Rate Limiting

```typescript
// packages/core/src/security/rate-limiter.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ─── Layer 1: Global rate limiting (per IP) ───
// Protects against DDoS and brute force
const globalLimiter = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, '1 m'), // 100 req/min per IP
  prefix: 'netpro:global',
});

// ─── Layer 2: Per-user rate limiting ───
// Prevents individual abuse
const userLimiter = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(1000, '1 h'), // 1000 req/hr per user
  prefix: 'netpro:user',
});

// ─── Layer 3: Per-endpoint limiting ───
// Expensive operations get stricter limits
const endpointLimits: Record<string, { requests: number; window: string }> = {
  '/api/enrich':     { requests: 50, window: '1 h' },   // Costs money
  '/api/outreach':   { requests: 100, window: '1 h' },  // Spam prevention
  '/api/search':     { requests: 200, window: '1 h' },  // API cost
  '/api/ai/compose': { requests: 50, window: '1 h' },   // LLM cost
  '/api/export':     { requests: 10, window: '1 h' },   // Resource intensive
};

// ─── Layer 4: Campaign sending limits ───
// Anti-spam: max emails per day
const campaignLimiter = {
  maxPerDay: 200,
  maxPerHour: 50,
  minDelayBetween: 30, // seconds
  warmupSchedule: [    // New accounts start slow
    { day: 1, limit: 20 },
    { day: 7, limit: 50 },
    { day: 14, limit: 100 },
    { day: 30, limit: 200 },
  ],
};

export async function checkRateLimit(req: NextRequest): Promise<RateLimitResult> {
  const ip = req.ip ?? req.headers.get('x-forwarded-for') ?? 'unknown';
  const userId = req.auth?.user?.id;
  const endpoint = req.nextUrl.pathname;
  
  // Layer 1: Global
  const globalResult = await globalLimiter.limit(ip);
  if (!globalResult.success) {
    return { allowed: false, retryAfter: globalResult.reset, reason: 'ip_limit' };
  }
  
  // Layer 2: Per-user (if authenticated)
  if (userId) {
    const userResult = await userLimiter.limit(userId);
    if (!userResult.success) {
      return { allowed: false, retryAfter: userResult.reset, reason: 'user_limit' };
    }
  }
  
  // Layer 3: Per-endpoint
  const epLimit = endpointLimits[endpoint];
  if (epLimit && userId) {
    const epLimiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(epLimit.requests, epLimit.window),
      prefix: `netpro:ep:${endpoint}`,
    });
    const epResult = await epLimiter.limit(userId);
    if (!epResult.success) {
      return { allowed: false, retryAfter: epResult.reset, reason: 'endpoint_limit' };
    }
  }
  
  return { allowed: true };
}
```

---

### 4.2 Rate Limiting for Self-Hosted (No Redis)

```typescript
// packages/core/src/security/rate-limiter-local.ts

/**
 * In-memory rate limiter for CLI and self-hosted (no Redis dependency).
 * Uses token bucket algorithm with SQLite persistence for restart resilience.
 */
export class LocalRateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  
  constructor(private config: {
    defaultRate: number;     // tokens per window
    windowMs: number;        // window duration in ms
    persistPath?: string;    // SQLite path for persistence
  }) {}
  
  async consume(key: string, tokens = 1): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    let bucket = this.buckets.get(key);
    
    if (!bucket) {
      bucket = new TokenBucket(this.config.defaultRate, this.config.windowMs);
      this.buckets.set(key, bucket);
    }
    
    const result = bucket.consume(tokens);
    
    return {
      allowed: result.consumed,
      remaining: result.remaining,
      resetAt: result.resetAt,
    };
  }
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  
  constructor(private maxTokens: number, private refillMs: number) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }
  
  consume(count: number): { consumed: boolean; remaining: number; resetAt: number } {
    this.refill();
    
    if (this.tokens >= count) {
      this.tokens -= count;
      return { consumed: true, remaining: this.tokens, resetAt: this.lastRefill + this.refillMs };
    }
    
    return { consumed: false, remaining: this.tokens, resetAt: this.lastRefill + this.refillMs };
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    
    if (elapsed >= this.refillMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}
```

---

### 4.3 Anti-Spam Controls for Outreach

```typescript
// packages/core/src/outreach/spam-guard.ts

export interface SpamGuardConfig {
  maxDailyEmails: number;
  maxPerRecipientPerWeek: number;
  requiredCooldownHours: number;
  blacklistedDomains: string[];
  requireUnsubscribeLink: boolean;
  requireManualApproval: boolean;    // For first N sends
}

export class SpamGuard {
  constructor(private config: SpamGuardConfig, private db: Database) {}
  
  async canSend(userId: string, recipientEmail: string): Promise<SpamCheckResult> {
    const checks: SpamCheckResult['violations'] = [];
    
    // 1. Daily limit
    const sentToday = await this.countSentToday(userId);
    if (sentToday >= this.config.maxDailyEmails) {
      checks.push({ rule: 'daily_limit', message: `Daily limit reached (${this.config.maxDailyEmails})` });
    }
    
    // 2. Per-recipient limit (no harassment)
    const sentToRecipient = await this.countSentToRecipientThisWeek(userId, recipientEmail);
    if (sentToRecipient >= this.config.maxPerRecipientPerWeek) {
      checks.push({ rule: 'recipient_limit', message: 'Already emailed this person this week' });
    }
    
    // 3. Cooldown between sends
    const lastSent = await this.getLastSentTime(userId);
    if (lastSent) {
      const hoursSince = (Date.now() - lastSent.getTime()) / 3600000;
      if (hoursSince < this.config.requiredCooldownHours) {
        checks.push({ rule: 'cooldown', message: `Wait ${this.config.requiredCooldownHours}h between sends` });
      }
    }
    
    // 4. Domain blacklist
    const domain = recipientEmail.split('@')[1];
    if (this.config.blacklistedDomains.includes(domain)) {
      checks.push({ rule: 'blacklisted_domain', message: `Cannot send to ${domain}` });
    }
    
    // 5. Bounce rate check (protect sender reputation)
    const bounceRate = await this.getBounceRate(userId);
    if (bounceRate > 0.05) { // >5% bounce rate
      checks.push({ rule: 'high_bounce_rate', message: 'Bounce rate too high — verify emails before sending' });
    }
    
    return {
      allowed: checks.length === 0,
      violations: checks,
    };
  }
  
  /**
   * Content scanning — basic checks (not a full spam filter)
   */
  async scanContent(subject: string, body: string): Promise<ContentScanResult> {
    const flags: string[] = [];
    
    // Spam trigger words
    const spamTriggers = /\b(free money|guaranteed|act now|limited time|click here|buy now)\b/gi;
    if (spamTriggers.test(body) || spamTriggers.test(subject)) {
      flags.push('Contains common spam trigger words');
    }
    
    // All caps check
    const capsRatio = (body.match(/[A-Z]/g)?.length ?? 0) / body.length;
    if (capsRatio > 0.3) {
      flags.push('Excessive capitalization');
    }
    
    // URL count
    const urlCount = (body.match(/https?:\/\//g) ?? []).length;
    if (urlCount > 3) {
      flags.push('Too many links (may trigger spam filters)');
    }
    
    // Personalization check (should have merge vars)
    if (!body.includes('{{') && body.length > 100) {
      flags.push('Consider adding personalization variables');
    }
    
    return {
      score: flags.length === 0 ? 'clean' : flags.length < 3 ? 'warning' : 'risky',
      flags,
    };
  }
}
```

---

## Part 5: Input Validation & Injection Prevention

---

### 5.1 Input Validation Layer

```typescript
// packages/core/src/validation/schemas.ts
import { z } from 'zod';

// ─── Contact creation/update ───
export const contactSchema = z.object({
  fullName: z.string().min(1).max(200).trim(),
  email: z.string().email().optional().or(z.literal('')),
  company: z.string().max(200).trim().optional(),
  role: z.string().max(200).trim().optional(),
  location: z.string().max(300).trim().optional(),
  linkedinUrl: z.string().url().regex(/linkedin\.com/).optional().or(z.literal('')),
  githubUrl: z.string().url().regex(/github\.com/).optional().or(z.literal('')),
  phone: z.string().max(20).regex(/^[\d\s\-+()]+$/).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  notes: z.string().max(10000).optional(),
});

// ─── Search query ───
export const searchQuerySchema = z.object({
  query: z.string().max(500).trim().optional(),
  role: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
  location: z.string().max(100).optional(),
  seniority: z.enum(['intern', 'junior', 'mid', 'senior', 'lead', 'director', 'vp', 'c_level']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

// ─── Outreach message ───
export const outreachSchema = z.object({
  recipientEmail: z.string().email(),
  subject: z.string().min(1).max(200).trim(),
  body: z.string().min(10).max(5000).trim(),
  // Prevent email header injection
  replyTo: z.string().email().optional(),
}).refine(
  (data) => !data.subject.includes('\n') && !data.subject.includes('\r'),
  { message: 'Subject cannot contain newlines (header injection attempt)', path: ['subject'] }
);

// ─── Campaign creation ───
export const campaignSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  template: z.object({
    subject: z.string().min(1).max(200),
    body: z.string().min(10).max(5000),
    variables: z.array(z.string().max(50)).max(20),
  }),
  dailyLimit: z.number().int().min(1).max(200).default(50),
  recipients: z.array(z.string().uuid()).min(1).max(1000),
});

// ─── API key submission ───
export const apiKeySchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'hunter', 'pdl', 'clearbit']),
  key: z.string().min(10).max(200),
  name: z.string().max(50).optional(),
}).refine(
  (data) => {
    // Validate key format per provider
    const formats: Record<string, RegExp> = {
      openai: /^sk-[a-zA-Z0-9_-]{20,}$/,
      anthropic: /^sk-ant-[a-zA-Z0-9_-]{20,}$/,
      hunter: /^[a-f0-9]{40}$/,
      pdl: /^[a-f0-9]{64}$/,
    };
    return !formats[data.provider] || formats[data.provider].test(data.key);
  },
  { message: 'Invalid API key format for this provider' }
);
```

---

### 5.2 SQL Injection Prevention

```typescript
// Already handled by Drizzle ORM's parameterized queries, but explicit safeguards:

// ❌ NEVER: String interpolation in SQL
// const results = db.all(`SELECT * FROM contacts WHERE name = '${userInput}'`);

// ✅ ALWAYS: Parameterized via Drizzle
// const results = db.select().from(contacts).where(eq(contacts.fullName, userInput));

// ✅ For raw SQL (FTS5): use parameterized templates
// db.all(sql`SELECT * FROM contacts_fts WHERE contacts_fts MATCH ${sanitizedQuery}`);

// FTS5 query sanitization (prevent FTS injection)
export function sanitizeFTSQuery(input: string): string {
  // Remove FTS5 operators that could be abused
  return input
    .replace(/[{}()"^*]/g, '')     // Remove special FTS chars
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')  // Remove boolean operators
    .trim()
    .split(/\s+/)
    .slice(0, 10)                   // Max 10 terms
    .map(term => `"${term}"`)       // Quote each term
    .join(' ');
}
```

---

### 5.3 XSS Prevention

```typescript
// apps/web/lib/sanitize.ts
import DOMPurify from 'isomorphic-dompurify';

/**
 * Sanitize user-generated content before rendering.
 * Used for: notes, custom fields, imported data that may contain HTML.
 */
export function sanitizeHTML(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'br', 'p', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Escape for plain text contexts (email subjects, etc.)
 */
export function escapeText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Next.js RSC already escapes by default, but explicit for dynamic content:
// <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(contact.notes) }} />
```

---

## Part 6: CSRF, CORS & Security Headers

---

### 6.1 Security Headers (Next.js)

```typescript
// apps/web/next.config.ts
import type { NextConfig } from 'next';

const securityHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Required for Next.js
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' https://api.openai.com https://api.anthropic.com https://api.hunter.io https://api.peopledatalabs.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const config: NextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default config;
```

---

### 6.2 CSRF Protection

```typescript
// Auth.js v5 handles CSRF automatically for auth routes.
// For custom API routes, use double-submit cookie pattern:

// apps/web/lib/csrf.ts
import { randomBytes, createHmac } from 'crypto';

const CSRF_SECRET = process.env.CSRF_SECRET!;
const CSRF_COOKIE = '__Host-netpro.csrf';
const CSRF_HEADER = 'x-csrf-token';

export function generateCSRFToken(): { token: string; cookie: string } {
  const nonce = randomBytes(32).toString('hex');
  const signature = createHmac('sha256', CSRF_SECRET).update(nonce).digest('hex');
  
  return {
    token: `${nonce}.${signature}`,  // Sent in header by client
    cookie: nonce,                    // Set as HttpOnly cookie
  };
}

export function validateCSRFToken(headerToken: string, cookieNonce: string): boolean {
  const [nonce, signature] = headerToken.split('.');
  
  // Cookie must match nonce
  if (nonce !== cookieNonce) return false;
  
  // Signature must be valid
  const expected = createHmac('sha256', CSRF_SECRET).update(nonce).digest('hex');
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}
```

---

## Part 7: Audit Logging & Compliance

---

### 7.1 Comprehensive Audit Trail

```typescript
// packages/core/src/audit/logger.ts

export type AuditAction =
  // Data access
  | 'contact.viewed' | 'contact.searched' | 'contact.exported'
  // Data modification
  | 'contact.created' | 'contact.updated' | 'contact.deleted'
  | 'contact.enriched' | 'contact.merged'
  // Communication
  | 'email.composed' | 'email.sent' | 'email.opened'
  | 'campaign.created' | 'campaign.started' | 'campaign.paused'
  // Security events
  | 'auth.login' | 'auth.logout' | 'auth.failed'
  | 'apikey.added' | 'apikey.revoked' | 'apikey.used'
  // Admin
  | 'data.imported' | 'data.exported' | 'data.purged'
  | 'settings.changed';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  userId: string;
  
  // What was affected
  entityType?: string;
  entityId?: string;
  
  // Context
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  
  // Tamper detection
  previousHash?: string;  // Hash of previous entry (chain)
  entryHash: string;      // Hash of this entry
}

export class AuditLogger {
  private lastHash: string = '';
  
  async log(entry: Omit<AuditEntry, 'id' | 'timestamp' | 'entryHash' | 'previousHash'>): Promise<void> {
    const id = nanoid();
    const timestamp = new Date().toISOString();
    
    // Chain integrity: each entry references the previous hash
    const previousHash = this.lastHash;
    
    const fullEntry: AuditEntry = {
      id,
      timestamp,
      previousHash,
      ...entry,
      entryHash: '', // Computed below
    };
    
    // Compute hash of this entry (for tamper detection)
    fullEntry.entryHash = this.computeHash(fullEntry);
    this.lastHash = fullEntry.entryHash;
    
    // Persist
    await db.insert(activityLog).values({
      id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: JSON.stringify({
        ...entry.metadata,
        ip: entry.ipAddress,
        ua: entry.userAgent,
        prevHash: previousHash,
        hash: fullEntry.entryHash,
      }),
      createdAt: timestamp,
    });
  }
  
  private computeHash(entry: AuditEntry): string {
    const content = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      userId: entry.userId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      previousHash: entry.previousHash,
    });
    return createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Verify audit log integrity (detect tampering)
   */
  async verifyChain(): Promise<{ valid: boolean; brokenAt?: string }> {
    const entries = await db.select().from(activityLog).orderBy(activityLog.createdAt);
    
    let prevHash = '';
    for (const entry of entries) {
      const meta = JSON.parse(entry.metadata || '{}');
      if (meta.prevHash !== prevHash) {
        return { valid: false, brokenAt: entry.id };
      }
      prevHash = meta.hash;
    }
    
    return { valid: true };
  }
}
```

---

### 7.2 GDPR Compliance Features

```typescript
// packages/core/src/compliance/gdpr.ts

export class GDPRService {
  
  /**
   * Right to Access — export all user data
   */
  async exportUserData(userId: string): Promise<Buffer> {
    const data = {
      exportDate: new Date().toISOString(),
      account: await this.getAccountInfo(userId),
      contacts: await db.select().from(contacts).where(eq(contacts.ownerId, userId)),
      interactions: await this.getUserInteractions(userId),
      campaigns: await db.select().from(campaigns).where(eq(campaigns.ownerId, userId)),
      apiKeys: await this.getKeyMetadata(userId), // Metadata only, not actual keys
      auditLog: await this.getUserAuditLog(userId),
      settings: await this.getUserSettings(userId),
    };
    
    return Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }
  
  /**
   * Right to Erasure — delete all user data
   */
  async deleteAllUserData(userId: string): Promise<DeletionReport> {
    const report: DeletionReport = { deletedAt: new Date().toISOString(), tables: {} };
    
    // Order matters (foreign keys)
    const tables = [
      { name: 'enrichments', query: () => this.deleteUserEnrichments(userId) },
      { name: 'campaign_recipients', query: () => this.deleteUserCampaignRecipients(userId) },
      { name: 'campaigns', query: () => db.delete(campaigns).where(eq(campaigns.ownerId, userId)) },
      { name: 'interactions', query: () => this.deleteUserInteractions(userId) },
      { name: 'edges', query: () => this.deleteUserEdges(userId) },
      { name: 'follow_ups', query: () => this.deleteUserFollowUps(userId) },
      { name: 'contacts', query: () => db.delete(contacts).where(eq(contacts.ownerId, userId)) },
      { name: 'api_keys', query: () => db.delete(userApiKeys).where(eq(userApiKeys.userId, userId)) },
      { name: 'profile_views', query: () => db.delete(profileViews).where(eq(profileViews.ownerId, userId)) },
      { name: 'account', query: () => db.delete(users).where(eq(users.id, userId)) },
    ];
    
    for (const table of tables) {
      const result = await table.query();
      report.tables[table.name] = { rowsDeleted: result.rowsAffected };
    }
    
    // Log the deletion itself (retained for compliance audit)
    await auditLogger.log({
      action: 'data.purged',
      userId: 'system',
      metadata: { purgedUserId: userId, report },
    });
    
    return report;
  }
  
  /**
   * Data retention policy — auto-cleanup old data
   */
  async enforceRetention(): Promise<void> {
    // Delete soft-deleted contacts after 30 days
    await db.delete(contacts).where(
      and(
        sql`${contacts.deletedAt} IS NOT NULL`,
        sql`${contacts.deletedAt} < datetime('now', '-30 days')`
      )
    );
    
    // Delete old audit logs after 1 year (configurable)
    await db.delete(activityLog).where(
      sql`${activityLog.createdAt} < datetime('now', '-365 days')`
    );
    
    // Delete expired enrichment cache
    await db.delete(enrichments).where(
      and(
        sql`${enrichments.expiresAt} IS NOT NULL`,
        sql`${enrichments.expiresAt} < datetime('now')`
      )
    );
  }
}
```

---

## Part 8: Threat Model & Mitigations

---

### 8.1 Threat Matrix

| Threat | Severity | Likelihood | Mitigation |
|--------|----------|-----------|------------|
| **DB breach (hosted)** | High | Medium | Per-user encryption, RLS, encrypted backups |
| **API key theft** | High | Low | AES-256-GCM, per-user derivation, key rotation |
| **Account takeover** | High | Low | OAuth only (no passwords), 2FA via provider |
| **Email spam abuse** | Medium | High | Rate limiting, warmup schedule, bounce monitoring |
| **Data exfiltration** | High | Low | Audit logging, export limits, anomaly detection |
| **XSS via imported data** | Medium | Medium | DOMPurify sanitization, CSP headers |
| **SSRF via enrichment** | Medium | Low | URL allowlist for enrichment providers |
| **Denial of service** | Medium | Medium | Multi-layer rate limiting, Vercel's edge protection |
| **Supply chain attack** | High | Low | Lockfile pinning, npm audit CI, minimal deps |
| **CLI token theft** | Medium | Low | OS keychain, token rotation, scope limitation |

---

### 8.2 Security Checklist (Pre-Launch)

```markdown
## Security Audit Checklist

### Authentication
- [ ] All auth flows use HTTPS only
- [ ] Session tokens are HttpOnly, Secure, SameSite=Lax
- [ ] JWT tokens expire within 1 hour (access) / 30 days (refresh)
- [ ] Failed login attempts are rate-limited (5/min per IP)
- [ ] OAuth state parameter validated (CSRF in OAuth flow)
- [ ] CLI device tokens can be revoked remotely

### Data Protection
- [ ] SQLite encrypted with SQLCipher (CLI)
- [ ] Postgres uses RLS + TDE (hosted)
- [ ] API keys encrypted at rest (AES-256-GCM)
- [ ] PII fields use column-level encryption where needed
- [ ] Backups are encrypted before storage
- [ ] No secrets in logs, error messages, or stack traces

### Input Validation
- [ ] All inputs validated with Zod schemas
- [ ] SQL queries parameterized (Drizzle ORM)
- [ ] FTS queries sanitized (no injection)
- [ ] File uploads validated (type, size, content)
- [ ] Email headers sanitized (no CRLF injection)
- [ ] URLs validated against allowlist (SSRF prevention)

### Rate Limiting
- [ ] Global: 100 req/min per IP
- [ ] Per-user: 1000 req/hr
- [ ] Sensitive endpoints: custom limits
- [ ] Campaign sending: warmup schedule enforced
- [ ] API enrichment: provider rate limits respected

### Headers & Transport
- [ ] HSTS enabled (max-age=63072000)
- [ ] X-Frame-Options: SAMEORIGIN
- [ ] CSP configured and tested
- [ ] CORS restricted to known origins
- [ ] No sensitive data in URL parameters

### Compliance
- [ ] GDPR data export endpoint working
- [ ] GDPR data deletion endpoint working
- [ ] Retention policy enforced automatically
- [ ] Audit log with tamper detection
- [ ] Privacy policy documenting all data processing
- [ ] Cookie consent (if using analytics)

### Supply Chain
- [ ] pnpm lockfile committed and verified
- [ ] npm audit runs in CI (block on critical)
- [ ] Dependabot / Renovate configured
- [ ] No unnecessary runtime dependencies
- [ ] Docker images use distroless/alpine base
```

---

## Part 9: Environment Configuration

---

### 9.1 Environment Variables

```bash
# apps/web/.env.example
# ═══════════════════════════════════════════
# CORE (required)
# ═══════════════════════════════════════════
DATABASE_URL="postgresql://..."          # Supabase connection string
NEXTAUTH_URL="https://your-domain.com"
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"

# ═══════════════════════════════════════════
# ENCRYPTION (required)
# ═══════════════════════════════════════════
ENCRYPTION_MASTER_KEY="generate-with-openssl-rand-base64-32"  # For API key vault
CSRF_SECRET="generate-with-openssl-rand-base64-32"

# ═══════════════════════════════════════════
# AUTH PROVIDERS (at least one required)
# ═══════════════════════════════════════════
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# ═══════════════════════════════════════════
# RATE LIMITING (optional — uses in-memory if not set)
# ═══════════════════════════════════════════
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""

# ═══════════════════════════════════════════
# ENRICHMENT APIs (user provides via UI, these are system defaults)
# ═══════════════════════════════════════════
# HUNTER_API_KEY=""          # System key for shared enrichment (Pro tier only)
# PDL_API_KEY=""             # System key for shared enrichment (Pro tier only)

# ═══════════════════════════════════════════
# EMAIL (for auth magic links + system emails)
# ═══════════════════════════════════════════
RESEND_API_KEY=""
EMAIL_FROM="NetPro <noreply@netpro.dev>"

# ═══════════════════════════════════════════
# JOBS (optional — uses local cron if not set)
# ═══════════════════════════════════════════
INNGEST_EVENT_KEY=""
INNGEST_SIGNING_KEY=""
```

---

### 9.2 Secret Generation Script

```bash
#!/bin/bash
# scripts/generate-secrets.sh
# Run once during initial setup

echo "Generating NetPro secrets..."
echo ""
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
echo "ENCRYPTION_MASTER_KEY=$(openssl rand -base64 32)"
echo "CSRF_SECRET=$(openssl rand -base64 32)"
echo ""
echo "Add these to your .env.local file (NEVER commit to git)"
```

---

## Summary: Security Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ┌─────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────┐  │
│   │  Edge   │───▶│  Rate Limit  │───▶│    Auth      │───▶│  App    │  │
│   │ (Vercel)│    │  (Upstash)   │    │  (Auth.js)   │    │  Logic  │  │
│   └─────────┘    └──────────────┘    └──────────────┘    └────┬────┘  │
│                                                                │       │
│   Security layers (outside → inside):                          │       │
│                                                                ▼       │
│   1. TLS 1.3 (Vercel edge)                             ┌──────────┐   │
│   2. Security headers (CSP, HSTS, X-Frame)              │ Key Vault│   │
│   3. Rate limiting (IP + user + endpoint)               │(AES-256) │   │
│   4. CSRF validation (double-submit cookie)             └─────┬────┘   │
│   5. Auth (JWT verification)                                  │        │
│   6. Input validation (Zod schemas)                           ▼        │
│   7. SQL parameterization (Drizzle ORM)                ┌──────────┐   │
│   8. Output sanitization (DOMPurify)                    │ Database │   │
│   9. Encryption at rest (SQLCipher / TDE)               │(Encrypted│   │
│   10. Audit logging (tamper-evident chain)              │ + RLS)   │   │
│                                                         └──────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

*Security is not a feature — it's a layer cake. Each layer assumes the one above it has failed.*
