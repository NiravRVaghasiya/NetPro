// packages/core/src/providers/index.ts
//
// Phase 17 — Optional AI and Enrichment.
//
// NetPro must work — completely — with no external provider configured:
//
//   OpenAI · Anthropic · Hunter · People Data Labs · Clearbit · embeddings
//
// are enhancements. When they are configured they enhance; when they are not,
// NetPro still runs. This module is the single place that answers "which
// providers are available right now, and what does that mean for what NetPro
// can do?" so the CLI, the server (`GET /api/providers`), and the Web UI read
// one answer instead of three guesses:
//
//   AI           ● Not configured
//   Enrichment   ● Hunter configured
//   Embeddings   ● Disabled
//
// Rules:
//   * Pure: an env record in, a status snapshot out. No I/O, no keychain
//     reads, no network. The CLI loads its encrypted keychain and passes the
//     values in; the server passes `process.env`.
//   * Never leaks key material — the snapshot carries booleans and *where* a
//     key came from, never the key itself.
//   * Never throws for a missing provider. "Not configured" is a status, not
//     an error path — callers degrade instead of failing.

export type ProviderCategory = "ai" | "enrichment" | "embeddings" | "content";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "hunter"
  | "pdl"
  | "clearbit"
  | "embeddings-openai"
  | "devto"
  | "twitter"
  | "github";

export type ProviderSource = "env" | "keychain" | "none";

export type CapabilityId =
  | "import"
  | "scan"
  | "keywordSearch"
  | "semanticSearch"
  | "graphAnalytics"
  | "enrichment"
  | "aiOutreach"
  | "contentSync";

export type CapabilityState = "available" | "disabled";

export interface ProviderDescriptor {
  id: ProviderId;
  /** Short human name used in UI/CLI output. */
  label: string;
  category: ProviderCategory;
  /** Any one of these being non-empty means the provider is configured. */
  envVars: readonly string[];
  /** CLI keychain slots (`netpro config set <slot> …`). */
  keychainKeys?: readonly string[];
  /** What the provider buys you — shown next to the status dot. */
  purpose: string;
  /** Literal: every provider in NetPro is optional (Phase 17). */
  optional: true;
}

/**
 * The catalog. Adding a provider is a data change here plus a call site —
 * status surfaces (CLI, server, Web UI) pick it up automatically.
 */
export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    id: "openai",
    label: "OpenAI",
    category: "ai",
    envVars: ["OPENAI_API_KEY", "NETPRO_OPENAI_KEY"],
    keychainKeys: ["ai.openai.key"],
    purpose: "AI draft generation for outreach (`netpro outreach`).",
    optional: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    category: "ai",
    envVars: ["ANTHROPIC_API_KEY", "NETPRO_ANTHROPIC_KEY"],
    keychainKeys: ["ai.anthropic.key"],
    purpose: "Alternative provider for outreach draft generation.",
    optional: true,
  },
  {
    id: "hunter",
    label: "Hunter",
    category: "enrichment",
    envVars: ["HUNTER_API_KEY"],
    keychainKeys: ["enrichment.hunter"],
    purpose: "Email finding during contact enrichment.",
    optional: true,
  },
  {
    id: "pdl",
    label: "People Data Labs",
    category: "enrichment",
    envVars: ["PDL_API_KEY"],
    keychainKeys: ["enrichment.pdl"],
    purpose: "Profile enrichment (company, role, industry).",
    optional: true,
  },
  {
    id: "clearbit",
    label: "Clearbit",
    category: "enrichment",
    envVars: ["CLEARBIT_API_KEY"],
    keychainKeys: ["enrichment.clearbit"],
    purpose: "Company and domain enrichment.",
    optional: true,
  },
  {
    id: "embeddings-openai",
    label: "OpenAI embeddings",
    category: "embeddings",
    envVars: ["EMBEDDINGS_API_KEY", "OPENAI_API_KEY"],
    keychainKeys: ["embeddings.key"],
    purpose: "Semantic (vector) search over contacts.",
    optional: true,
  },
  {
    id: "devto",
    label: "DEV.to",
    category: "content",
    envVars: ["DEVTO_API_KEY"],
    keychainKeys: ["content.devto"],
    purpose: "Publish and sync cross-posted content.",
    optional: true,
  },
  {
    id: "twitter",
    label: "X / Twitter",
    category: "content",
    envVars: ["TWITTER_BEARER_TOKEN"],
    keychainKeys: ["content.twitter"],
    purpose: "Content metrics for cross-posted links.",
    optional: true,
  },
  {
    id: "github",
    label: "GitHub",
    category: "content",
    envVars: ["GITHUB_TOKEN"],
    keychainKeys: ["content.github"],
    purpose: "Repository content sync and metrics.",
    optional: true,
  },
] as const;

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  ai: "AI",
  enrichment: "Enrichment",
  embeddings: "Embeddings",
  content: "Content",
};

/** Display order for the plan's status strips. */
export const CATEGORY_ORDER: readonly ProviderCategory[] = [
  "ai",
  "enrichment",
  "embeddings",
  "content",
] as const;

export interface ProviderState {
  id: ProviderId;
  label: string;
  category: ProviderCategory;
  configured: boolean;
  source: ProviderSource;
  envVars: readonly string[];
  keychainKeys: readonly string[];
  purpose: string;
  optional: true;
}

export type CategoryStatus = "configured" | "not configured" | "disabled";

export interface ProviderCategoryState {
  id: ProviderCategory;
  label: string;
  configured: boolean;
  /** The plan's wording: "configured" / "not configured" / "disabled". */
  status: CategoryStatus;
  providers: ProviderState[];
  /** Labels of the configured providers, e.g. ["Hunter"]. */
  configuredProviders: string[];
  /** One-line detail, e.g. "Hunter configured" or "Not configured". */
  detail: string;
}

export interface DegradedCapability {
  capability: CapabilityId;
  label: string;
  reason: string;
  /** How to turn it on — a copy-pasteable hint, never a key. */
  enable: string;
}

export interface ProviderStatusSnapshot {
  generatedAt: string;
  /** Always true: NetPro runs with zero providers configured (Phase 17). */
  runsWithoutProviders: true;
  providers: ProviderState[];
  categories: ProviderCategoryState[];
  ai: ProviderCategoryState;
  enrichment: ProviderCategoryState;
  embeddings: ProviderCategoryState;
  content: ProviderCategoryState;
  capabilities: Record<CapabilityId, CapabilityState>;
  /** What is switched off right now, and why that is fine. */
  degraded: DegradedCapability[];
  /**
   * Non-fatal configuration problems (e.g. an unknown EMBEDDINGS_PROVIDER).
   * Reported, never thrown.
   */
  warnings: string[];
}

export type KeychainValues = Record<string, string | null | undefined>;

export interface ResolveProviderStatusOptions {
  /**
   * CLI keychain slots → value. The CLI decrypts `~/.netpro/credentials.enc`
   * and passes the values here; only presence is inspected and no value ever
   * leaves this function.
   */
  keychain?: KeychainValues;
  /** Injectable clock (tests). */
  now?: () => Date;
}

function hasEnv(env: Record<string, string | undefined>, names: readonly string[]): boolean {
  return names.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function hasKeychain(keychain: KeychainValues | undefined, names: readonly string[] | undefined): boolean {
  if (!keychain || !names) return false;
  return names.some((name) => {
    const value = keychain[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Embeddings need two things — an enabled provider and a key. An absent
 * `EMBEDDINGS_PROVIDER` is "disabled", not "unknown" (see
 * `resolveEmbeddingsConfig`), so a bare `OPENAI_API_KEY` never silently turns
 * the semantic arm on.
 */
function resolveEmbeddingsGate(
  env: Record<string, string | undefined>,
  keychain: KeychainValues | undefined
): { enabled: boolean; warning: string | null } {
  const raw = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "disabled" || raw === "none" || raw === "off") {
    return { enabled: false, warning: null };
  }
  if (raw !== "openai") {
    return {
      enabled: false,
      warning: `Unknown EMBEDDINGS_PROVIDER "${env.EMBEDDINGS_PROVIDER}". Expected "openai" or "disabled" — semantic search stays off.`,
    };
  }
  const hasKey =
    hasEnv(env, ["EMBEDDINGS_API_KEY", "OPENAI_API_KEY"]) || hasKeychain(keychain, ["embeddings.key"]);
  return {
    enabled: hasKey,
    warning: hasKey
      ? null
      : "EMBEDDINGS_PROVIDER=openai but no embeddings key found — semantic search stays off.",
  };
}

function stateFor(
  descriptor: ProviderDescriptor,
  env: Record<string, string | undefined>,
  keychain: KeychainValues | undefined,
  override?: { configured: boolean; source?: ProviderSource }
): ProviderState {
  const fromEnv = hasEnv(env, descriptor.envVars);
  const fromKeychain = hasKeychain(keychain, descriptor.keychainKeys);
  const configured = override ? override.configured : fromEnv || fromKeychain;
  const source: ProviderSource = !configured
    ? "none"
    : (override?.source ?? (fromEnv ? "env" : "keychain"));
  return {
    id: descriptor.id,
    label: descriptor.label,
    category: descriptor.category,
    configured,
    source,
    envVars: descriptor.envVars,
    keychainKeys: descriptor.keychainKeys ?? [],
    purpose: descriptor.purpose,
    optional: true,
  };
}

/**
 * Build one category row. `forceStatus` is only used for opt-in categories
 * (embeddings) that read as "Disabled" rather than "Not configured" when the
 * operator never switched them on.
 */
function categoryState(
  id: ProviderCategory,
  providers: ProviderState[],
  forceStatus?: CategoryStatus
): ProviderCategoryState {
  const configuredProviders = providers.filter((p) => p.configured).map((p) => p.label);
  const configured = configuredProviders.length > 0 && forceStatus !== "disabled";
  const status: CategoryStatus =
    forceStatus === "disabled"
      ? "disabled"
      : configuredProviders.length > 0
        ? "configured"
        : "not configured";
  const detail =
    status === "disabled"
      ? "Disabled"
      : configuredProviders.length > 0
        ? `${configuredProviders.join(", ")} configured`
        : "Not configured";
  return {
    id,
    label: CATEGORY_LABELS[id],
    configured,
    status,
    providers,
    configuredProviders,
    detail,
  };
}

const ENABLE_HINTS: Record<"ai" | "enrichment" | "embeddings" | "content", string> = {
  ai: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or `netpro config set ai.openai.key …`).",
  enrichment:
    "Set HUNTER_API_KEY, PDL_API_KEY, or CLEARBIT_API_KEY (or `netpro config set enrichment.hunter …`).",
  embeddings:
    "Set EMBEDDINGS_PROVIDER=openai plus EMBEDDINGS_API_KEY (or OPENAI_API_KEY), then run `netpro reindex --embeddings`.",
  content: "Set DEVTO_API_KEY, TWITTER_BEARER_TOKEN, or GITHUB_TOKEN.",
};

/**
 * Resolve provider status from an environment (and optional CLI keychain).
 *
 * Pure and total: any environment — including a completely empty one — yields
 * a snapshot in which the offline capabilities are `available` and every
 * external capability is `disabled` with an explanation.
 */
export function resolveProviderStatus(
  env: Record<string, string | undefined> = process.env,
  options: ResolveProviderStatusOptions = {}
): ProviderStatusSnapshot {
  const keychain = options.keychain;
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];

  const embeddingsGate = resolveEmbeddingsGate(env, keychain);
  if (embeddingsGate.warning) warnings.push(embeddingsGate.warning);

  const providers: ProviderState[] = PROVIDER_CATALOG.map((descriptor) => {
    if (descriptor.category === "embeddings") {
      const hasKey = hasEnv(env, descriptor.envVars) || hasKeychain(keychain, descriptor.keychainKeys);
      return stateFor(descriptor, env, keychain, {
        configured: embeddingsGate.enabled && hasKey,
        source: hasKey ? (hasEnv(env, descriptor.envVars) ? "env" : "keychain") : "none",
      });
    }
    return stateFor(descriptor, env, keychain);
  });

  const byCategory = (id: ProviderCategory): ProviderState[] =>
    providers.filter((p) => p.category === id);

  const ai = categoryState("ai", byCategory("ai"));
  const enrichment = categoryState("enrichment", byCategory("enrichment"));
  // Embeddings are opt-in: without an explicit provider they read as
  // "Disabled" rather than "Not configured" — the plan's third strip.
  const embeddings = categoryState(
    "embeddings",
    byCategory("embeddings"),
    embeddingsGate.enabled ? undefined : "disabled"
  );
  const content = categoryState("content", byCategory("content"));

  const categories: ProviderCategoryState[] = CATEGORY_ORDER.map((id) =>
    id === "ai" ? ai : id === "enrichment" ? enrichment : id === "embeddings" ? embeddings : content
  );

  const capabilities: Record<CapabilityId, CapabilityState> = {
    // Offline capabilities — always available, no provider required.
    import: "available",
    scan: "available",
    keywordSearch: "available",
    graphAnalytics: "available",
    // Provider-backed capabilities — degrade, never block.
    semanticSearch: embeddings.configured ? "available" : "disabled",
    enrichment: enrichment.configured ? "available" : "disabled",
    aiOutreach: ai.configured ? "available" : "disabled",
    contentSync: content.configured ? "available" : "disabled",
  };

  const degraded: DegradedCapability[] = [];
  const degrade = (
    capability: CapabilityId,
    label: string,
    category: keyof typeof ENABLE_HINTS,
    reason: string
  ): void => {
    if (capabilities[capability] === "available") return;
    degraded.push({ capability, label, reason, enable: ENABLE_HINTS[category] });
  };

  degrade(
    "semanticSearch",
    "Semantic search",
    "embeddings",
    "Keyword search is unaffected; semantic ranking and `?mode=semantic` are off."
  );
  degrade(
    "enrichment",
    "Contact enrichment",
    "enrichment",
    "Imports, scans, and graph analysis run fully offline; enrichment steps are skipped."
  );
  degrade(
    "aiOutreach",
    "AI outreach drafts",
    "ai",
    "Campaigns and templates still work; drafts must be written by hand."
  );
  degrade(
    "contentSync",
    "Content provider sync",
    "content",
    "Manual content import and URL-based metrics still work."
  );

  return {
    generatedAt: now().toISOString(),
    runsWithoutProviders: true,
    providers,
    categories,
    ai,
    enrichment,
    embeddings,
    content,
    capabilities,
    degraded,
    warnings,
  };
}

/** Convenience: is this capability usable right now? */
export function capabilityAvailable(
  snapshot: ProviderStatusSnapshot,
  capability: CapabilityId
): boolean {
  return snapshot.capabilities[capability] === "available";
}

/** The configured enrichment provider ids, e.g. ["hunter", "clearbit"]. */
export function configuredEnrichmentProviders(
  env: Record<string, string | undefined> = process.env,
  options: ResolveProviderStatusOptions = {}
): ProviderId[] {
  return resolveProviderStatus(env, options)
    .enrichment.providers.filter((p) => p.configured)
    .map((p) => p.id);
}

/**
 * Construct the enrichment providers that are actually configured.
 *
 * Dynamic imports keep the provider modules (and their network clients) out of
 * the import graph for the common, provider-free case. Returns an empty array
 * when nothing is configured — callers treat that as "skip enrichment".
 */
export async function createEnrichmentProviders(
  env: Record<string, string | undefined> = process.env,
  options: ResolveProviderStatusOptions = {}
): Promise<unknown[]> {
  const status = resolveProviderStatus(env, options);
  const configured = new Set(status.enrichment.providers.filter((p) => p.configured).map((p) => p.id));
  if (configured.size === 0) return [];

  const providers: unknown[] = [];
  const value = (names: readonly string[], keychainKeys: readonly string[]): string => {
    for (const name of names) {
      const v = env[name];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    for (const slot of keychainKeys) {
      const v = options.keychain?.[slot];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };

  if (configured.has("hunter")) {
    const { createHunterProvider } = await import("../enrichment/providers/hunter");
    const key = value(["HUNTER_API_KEY"], ["enrichment.hunter"]);
    if (key) providers.push(createHunterProvider(key));
  }
  if (configured.has("pdl")) {
    const { createPDLProvider } = await import("../enrichment/providers/pdl");
    const key = value(["PDL_API_KEY"], ["enrichment.pdl"]);
    if (key) providers.push(createPDLProvider(key));
  }
  if (configured.has("clearbit")) {
    const { createClearbitProvider } = await import("../enrichment/providers/clearbit");
    const key = value(["CLEARBIT_API_KEY"], ["enrichment.clearbit"]);
    if (key) providers.push(createClearbitProvider(key));
  }
  return providers;
}

/**
 * CLI/server text rendering of the plan's status block:
 *
 *   Providers (all optional — NetPro runs without them)
 *   AI           ● Not configured
 *   Enrichment   ● Hunter configured
 *   Embeddings   ● Disabled
 */
export function formatProviderStatus(snapshot: ProviderStatusSnapshot): string {
  const width = Math.max(...snapshot.categories.map((c) => c.label.length));
  const lines = ["Providers (all optional — NetPro runs without them)"];
  for (const category of snapshot.categories) {
    // The plan renders a filled dot on every row — the words carry the state.
    lines.push(`  ${category.label.padEnd(width)}   ● ${category.detail}`);
  }
  if (snapshot.degraded.length > 0) {
    lines.push("");
    lines.push("  Offline-capable — these are enhancements, not requirements:");
    for (const item of snapshot.degraded) {
      lines.push(`    • ${item.label}: ${item.reason}`);
      lines.push(`      Enable: ${item.enable}`);
    }
  }
  for (const warning of snapshot.warnings) {
    lines.push("");
    lines.push(`  Warning: ${warning}`);
  }
  return lines.join("\n");
}
