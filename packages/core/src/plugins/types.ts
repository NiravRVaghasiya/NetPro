// packages/core/src/plugins/types.ts
// v3.0 Phase 5 — plugin runtime & manifest contract.

export type PluginCapability =
  | 'source'
  | 'enricher'
  | 'ai-provider'
  | 'content-provider'
  | 'event-discovery'
  | 'command';

export interface SettingSpec {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface PluginManifest {
  name: string; // npm-style unique id
  version: string; // semver
  engine: string; // netpro version range, e.g. "^3.0.0"
  description?: string;
  homepage?: string;
  entry?: string; // relative path to entry file, default "index.js"
  permissions: {
    network?: string[]; // host allowlist
    capabilities: PluginCapability[];
  };
  settings?: SettingSpec[];
}

export interface Plugin {
  manifest: PluginManifest;
  register: (api: PluginApi) => void | Promise<void>;
}

export interface PluginRegistration {
  plugin: Plugin;
  manifest: PluginManifest;
  path: string; // filesystem path where loaded from
}

// PluginApi — injection, not ambient
export interface PluginApi {
  // workspace context
  readonly workspaceId: string;
  readonly userId: string;

  // fetch wrapper enforcing host allowlist
  fetch(url: string, init?: RequestInit): Promise<Response>;

  // settings reader (non-secret from plugin_settings JSON, secrets from vault)
  getSetting(key: string): unknown;
  getSecret(key: string): Promise<string | null>;

  // logger — structured, rate-capped, lifecycle only
  log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;

  // capability registrars — take existing interfaces
  registerEnricher(provider: import('../enrichment/types').EnrichmentProvider): void;
  registerAiProvider(provider: import('../ai/types').AiProvider): void;
  registerContentProvider(provider: import('../content/providers').ContentProvider): void;
  registerEventDiscoveryProvider(provider: import('../events/providers').EventDiscoveryProvider): void;
  registerCommand(name: string, description: string, action: (...args: unknown[]) => unknown): void;
}

export interface PluginRow {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  manifest: string; // JSON string
  enabled: boolean;
  installedFrom: string | null;
  installedByUser: string | null;
  pluginSettings: string | null; // JSON
  createdAt: string;
  updatedAt: string;
}

export interface PluginListItem {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  manifest: PluginManifest;
  enabled: boolean;
  installedFrom: string | null;
  installedByUser: string | null;
  settings: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export const PLUGIN_CAPABILITIES: PluginCapability[] = [
  'source',
  'enricher',
  'ai-provider',
  'content-provider',
  'event-discovery',
  'command',
];

export const MAX_SETTINGS = 100;
export const MAX_MANIFEST_SIZE = 20 * 1024; // 20 KiB
