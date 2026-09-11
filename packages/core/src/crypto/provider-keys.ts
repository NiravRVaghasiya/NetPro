// packages/core/src/crypto/provider-keys.ts
//
// The bridge between the provider catalog (`../providers` — what NetPro can
// use a key *for*) and the encrypted vault (`./vault` — *where* the key
// lives). One mapping, one set of checks, one connection test, shared by the
// server's credentials API and any future CLI surface:
//
//   provider id (openai, hunter, …) → vault slot (outreach.openai, …)
//
// Validation posture (no fake checks):
//
//   * Local format checks are syntactic only: length, printable characters,
//     no embedded whitespace. Provider key formats change, so documented
//     prefixes (`sk-…`, `sk-ant-…`) are soft warnings, never rejections.
//   * Remote checks exist only where the provider documents a cheap,
//     non-mutating, non-credit-consuming endpoint (OpenAI/Anthropic model
//     lists, Hunter account, GitHub user). Credit-consuming lookups (PDL,
//     Clearbit) and endpoints without a safe documented check (DEV, X/Twitter)
//     are `unsupported`: the key is stored securely and reported as saved
//     but not remotely validated.
//   * Outcomes and errors never carry key material — messages are canned
//     strings, and fetch failures (which can echo a URL that carries the
//     key, as Hunter's documented `api_key` query param does) are swallowed
//     into a generic "couldn't reach the provider".

import {
  PROVIDER_CATALOG,
  type ProviderCategory,
  type ProviderId,
} from "../providers";
import { VaultError } from "./key-vault";
import type { ProviderKey } from "./vault";

/** Every catalog provider maps to exactly one encrypted vault slot. */
export const PROVIDER_VAULT_SLOTS: Record<ProviderId, ProviderKey> = {
  openai: "outreach.openai",
  anthropic: "outreach.anthropic",
  hunter: "enrichment.hunter",
  pdl: "enrichment.pdl",
  clearbit: "enrichment.clearbit",
  "embeddings-openai": "embeddings.openai",
  devto: "content.devto",
  twitter: "content.twitter",
  github: "content.github",
};

export function vaultSlotForProvider(providerId: string): ProviderKey {
  const slot = (PROVIDER_VAULT_SLOTS as Record<string, ProviderKey>)[providerId];
  if (!slot) throw new VaultError(400, `Unknown provider "${providerId}".`);
  return slot;
}

export function providerForVaultSlot(slot: string): ProviderId | null {
  for (const [provider, mapped] of Object.entries(PROVIDER_VAULT_SLOTS)) {
    if (mapped === slot) return provider as ProviderId;
  }
  return null;
}

/** Providers with a cheap, safe, documented remote check (see below). */
const REMOTELY_VALIDATABLE: ReadonlySet<ProviderId> = new Set([
  "openai",
  "anthropic",
  "hunter",
  "embeddings-openai",
  "github",
]);

const UNSUPPORTED_REASONS: Record<string, string> = {
  pdl: "People Data Labs charges credits per lookup, so NetPro never probes it automatically.",
  clearbit:
    "Clearbit lookups need a company or domain to check against, so there is no safe automatic check.",
  devto: "DEV has no safe automatic key check, so the key is stored without remote validation.",
  twitter:
    "X/Twitter needs an app context to verify a token, so the key is stored without remote validation.",
};

export interface ConnectableProvider {
  id: ProviderId;
  label: string;
  category: ProviderCategory;
  /** One-line, non-technical purpose (from the catalog). */
  purpose: string;
  vaultSlot: ProviderKey;
  remotelyValidatable: boolean;
  /** Shown when remote validation is unavailable (or what the check does). */
  validationNote: string;
  envVars: readonly string[];
}

export function listConnectableProviders(): ConnectableProvider[] {
  return PROVIDER_CATALOG.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    category: descriptor.category,
    purpose: descriptor.purpose,
    vaultSlot: PROVIDER_VAULT_SLOTS[descriptor.id],
    remotelyValidatable: REMOTELY_VALIDATABLE.has(descriptor.id),
    validationNote:
      UNSUPPORTED_REASONS[descriptor.id] ??
      "NetPro verifies the key with the provider before saving it.",
    envVars: descriptor.envVars,
  }));
}

export function connectableProvider(providerId: string): ConnectableProvider {
  const found = listConnectableProviders().find((p) => p.id === providerId);
  if (!found) throw new VaultError(400, `Unknown provider "${providerId}".`);
  return found;
}

// ── Local format checks ──────────────────────────────────────────────

/** Mirrors the vault's own rule so local and server-side checks agree. */
export const API_KEY_MIN_CHARS = 8;
export const API_KEY_MAX_CHARS = 4096;

const KEY_CHARSET_RE = /^[!-~]+$/;

export interface ApiKeyFormatCheck {
  ok: boolean;
  /** Human-readable reason when `ok` is false (never contains the key). */
  error?: string;
  /** Soft, documented-format hints — shown alongside, never blocking. */
  warnings: string[];
}

/**
 * Syntactic checks for a pasted key. Pure and offline; the vault re-checks
 * length on save, so this is early, friendly feedback — not a security gate.
 */
export function checkApiKeyFormat(providerId: string, apiKey: string): ApiKeyFormatCheck {
  const key = (apiKey ?? "").trim();
  if (key.length < API_KEY_MIN_CHARS) {
    return {
      ok: false,
      warnings: [],
      error:
        "That key looks too short — check that you pasted the complete API key.",
    };
  }
  if (key.length > API_KEY_MAX_CHARS) {
    return {
      ok: false,
      warnings: [],
      error: "That key looks too long — check that you pasted only the API key.",
    };
  }
  if (!KEY_CHARSET_RE.test(key)) {
    return {
      ok: false,
      warnings: [],
      error:
        "That key contains spaces or unsupported characters — check that you pasted only the API key.",
    };
  }
  return { ok: true, warnings: prefixWarnings(providerId, key) };
}

/** Documented-format hints. Soft by design: formats change, rejections stick. */
function prefixWarnings(providerId: string, key: string): string[] {
  if (providerId === "openai" && !key.startsWith("sk-")) {
    return [
      'This doesn\u2019t look like an OpenAI key (they usually start with "sk-"). Saving anyway is safe — you can replace it anytime.',
    ];
  }
  if (providerId === "anthropic" && !key.startsWith("sk-ant-")) {
    return [
      'This doesn\u2019t look like an Anthropic key (they usually start with "sk-ant-"). Saving anyway is safe — you can replace it anytime.',
    ];
  }
  return [];
}

// ── Remote connection test ───────────────────────────────────────────

export type KeyTestStatus = "valid" | "invalid" | "unreachable" | "unsupported";

export interface KeyTestOutcome {
  status: KeyTestStatus;
  /** Human-readable result (never contains the key). */
  message: string;
}

export const KEY_TEST_MESSAGES = {
  valid: "Connected — the provider accepted this key.",
  invalid:
    "We couldn't validate this API key. Check that the key is correct, the provider is correct, and the key has the required permissions.",
  unreachable:
    "We couldn't reach the provider right now. Your key was not changed.",
  unsupported: (providerLabel: string): string =>
    `${providerLabel} has no safe automatic check, so this key can't be tested remotely. It is stored securely and will be used by the integration.`,
} as const;

export const KEY_TEST_TIMEOUT_MS = 10_000;

type FetchImpl = typeof fetch;

export interface TestProviderKeyOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Override for OpenAI-compatible endpoints (OpenRouter, local servers). */
  openaiBaseUrl?: string;
}

/**
 * Verify a key against its provider with a cheap, read-only request.
 * Returns `unsupported` where no safe documented check exists — never a
 * fabricated "valid". All failures collapse into canned messages so key
 * material (including Hunter's query-param key) can never leak into an
 * error, a log, or an API response.
 */
export async function testProviderKey(
  providerId: string,
  apiKey: string,
  options: TestProviderKeyOptions = {},
): Promise<KeyTestOutcome> {
  const provider = connectableProvider(providerId);
  const key = (apiKey ?? "").trim();
  if (!provider.remotelyValidatable) {
    return { status: "unsupported", message: KEY_TEST_MESSAGES.unsupported(provider.label) };
  }
  const format = checkApiKeyFormat(providerId, key);
  if (!format.ok) {
    return { status: "invalid", message: KEY_TEST_MESSAGES.invalid };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? KEY_TEST_TIMEOUT_MS;
  try {
    const request = buildCheckRequest(provider.id, key, options.openaiBaseUrl);
    const response = await fetchImpl(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 200 && response.status < 300) {
      return { status: "valid", message: KEY_TEST_MESSAGES.valid };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", message: KEY_TEST_MESSAGES.invalid };
    }
    return { status: "unreachable", message: KEY_TEST_MESSAGES.unreachable };
  } catch {
    return { status: "unreachable", message: KEY_TEST_MESSAGES.unreachable };
  }
}

function buildCheckRequest(
  providerId: ProviderId,
  key: string,
  openaiBaseUrl?: string,
): { url: string; init: RequestInit } {
  switch (providerId) {
    case "openai":
    case "embeddings-openai": {
      const base = (openaiBaseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
      return {
        url: `${base}/models`,
        init: { method: "GET", headers: { Authorization: `Bearer ${key}` } },
      };
    }
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        init: {
          method: "GET",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        },
      };
    case "hunter":
      // Hunter's documented auth is an `api_key` query param over HTTPS.
      // The URL (and any error mentioning it) never leaves this function.
      return {
        url: `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`,
        init: { method: "GET" },
      };
    case "github":
      return {
        url: "https://api.github.com/user",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/vnd.github+json",
          },
        },
      };
    default:
      // Unreachable: callers gate on `remotelyValidatable`, but fail closed.
      throw new VaultError(400, "This provider can't be tested remotely.");
  }
}
