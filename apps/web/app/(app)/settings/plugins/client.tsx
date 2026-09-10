'use client';

import { useEffect, useState } from 'react';

interface PluginItem {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  manifest: {
    name: string;
    version: string;
    engine: string;
    description?: string;
    homepage?: string;
    permissions: { network?: string[]; capabilities: string[] };
    settings?: Array<{ key: string; label: string; type: string; description?: string }>;
  };
  enabled: boolean;
  installedFrom: string | null;
  installedByUser: string | null;
  settings: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface MarketEntry {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  source: { type: string; url: string };
  manifest: {
    permissions: { network?: string[]; capabilities: string[] };
  };
}

interface MarketIndex {
  indexUrl: string;
  updatedAt: string;
  fromCache: boolean;
  plugins: MarketEntry[];
}

interface Props {
  initialPlugins: PluginItem[];
  workspaceId: string;
  role: string;
}

export default function PluginsClient({ initialPlugins, workspaceId: _workspaceId, role: _role }: Props) {
  const [plugins, setPlugins] = useState(initialPlugins);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, string>>({});
  // v3.0 Phase 6 — marketplace + permissions review gate.
  const [market, setMarket] = useState<MarketIndex | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketQuery, setMarketQuery] = useState('');
  const [pendingEnable, setPendingEnable] = useState<PluginItem | null>(null);
  const [reviewChecked, setReviewChecked] = useState(false);

  async function refreshInstalled() {
    const listRes = await fetch('/api/plugins');
    if (listRes.ok) {
      const list = await listRes.json();
      setPlugins(list);
    }
  }

  async function loadMarket(query?: string, refresh?: boolean) {
    setMarketLoading(true);
    setMarketError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (refresh) params.set('refresh', '1');
      const qs = params.toString();
      const res = await fetch(`/api/plugins/marketplace${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (!res.ok) {
        setMarketError(data.error || 'Could not load the marketplace index.');
        return;
      }
      setMarket(data);
    } catch (e: unknown) {
      setMarketError((e as Error).message);
    } finally {
      setMarketLoading(false);
    }
  }

  useEffect(() => {
    loadMarket();
  }, []);

  async function callAction(name: string, action: string, body?: Record<string, unknown>) {
    setLoading(`${name}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to ${action} ${name}`);
      } else {
        if (action === 'update') {
          setNotice(data.updated ? `Updated ${name} to ${data.plugin.version}.` : `${name} is already up to date.`);
        }
        await refreshInstalled();
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function installFromMarketplace(name: string) {
    setLoading(`${name}:install`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to install ${name}`);
      } else {
        setNotice(
          `Installed ${data.plugin.name}@${data.plugin.version} (disabled). Review its permissions below, then Enable.`
        );
        await refreshInstalled();
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function removePlugin(name: string) {
    if (!confirm(`Remove plugin ${name}? This unregisters it and deletes its files.`)) return;
    setLoading(`${name}:remove`);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) setError(data.error || `Failed to remove ${name}`);
      else {
        setNotice(data.filesRemoved ? `Removed ${name} (files deleted).` : `Removed ${name}.`);
        await refreshInstalled();
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function saveSettings(name: string) {
    const draft = settingsDrafts[name];
    if (!draft) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError('Settings must be valid JSON');
      return;
    }
    await callAction(name, 'settings', { settings: parsed });
  }

  function marketEntryFor(name: string): MarketEntry | undefined {
    return market?.plugins.find((entry) => entry.name === name);
  }

  return (
    <div>
      {error && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 rounded bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {plugins.length === 0 ? (
        <div className="rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
          No plugins installed. Pick one from the marketplace below, or install via CLI:{' '}
          <code>netpro plugin install example-event-discovery</code> — then review its permissions and enable it.
        </div>
      ) : (
        <div className="space-y-4">
          {plugins.map((p) => {
            const update = marketEntryFor(p.name);
            const updateAvailable = update && update.version !== p.version;
            return (
              <div key={p.id} className="rounded-xl border border-slate-200 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{p.name}@{p.version}</div>
                    <div className="text-xs text-slate-500">{p.manifest.description ?? ''}</div>
                    <div className="mt-1 text-xs">
                      <span className={p.enabled ? 'text-green-700' : 'text-slate-500'}>{p.enabled ? 'enabled' : 'disabled'}</span>
                      {p.installedFrom && <span className="ml-2 text-slate-400">from {p.installedFrom}</span>}
                      {updateAvailable && update && (
                        <span className="ml-2 text-amber-700">update available: {update.version}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {p.enabled ? (
                      <button
                        disabled={!!loading}
                        onClick={() => callAction(p.name, 'disable')}
                        className="rounded bg-slate-100 px-3 py-1 text-xs"
                      >
                        {loading === `${p.name}:disable` ? '...' : 'Disable'}
                      </button>
                    ) : (
                      <button
                        disabled={!!loading}
                        onClick={() => {
                          setPendingEnable(p);
                          setReviewChecked(false);
                        }}
                        className="rounded bg-emerald-600 px-3 py-1 text-xs text-white"
                      >
                        Enable
                      </button>
                    )}
                    {updateAvailable && (
                      <button
                        disabled={!!loading}
                        onClick={() => callAction(p.name, 'update', {})}
                        className="rounded bg-amber-100 px-3 py-1 text-xs text-amber-900"
                      >
                        {loading === `${p.name}:update` ? '...' : 'Update'}
                      </button>
                    )}
                    <button
                      disabled={!!loading}
                      onClick={() => removePlugin(p.name)}
                      className="rounded bg-red-50 px-3 py-1 text-xs text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {pendingEnable?.id === p.id && (
                  <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs">
                    <div className="font-semibold text-amber-900">Review permissions before enabling {p.name}</div>
                    <div className="mt-1">capabilities: {p.manifest.permissions.capabilities.join(', ')}</div>
                    <div>network: {(p.manifest.permissions.network ?? []).join(', ') || '(none)'}</div>
                    <div>engine: {p.manifest.engine}</div>
                    <label className="mt-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewChecked}
                        onChange={(e) => setReviewChecked(e.target.checked)}
                      />
                      I have reviewed these permissions and trust this plugin&apos;s code.
                    </label>
                    <div className="mt-2 flex gap-2">
                      <button
                        disabled={!!loading || !reviewChecked}
                        onClick={async () => {
                          await callAction(p.name, 'enable', { reviewed: true });
                          setPendingEnable(null);
                        }}
                        className="rounded bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-40"
                      >
                        {loading === `${p.name}:enable` ? '...' : 'Confirm enable'}
                      </button>
                      <button
                        onClick={() => setPendingEnable(null)}
                        className="rounded bg-slate-100 px-3 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 text-xs">
                  <div className="font-medium">Permissions</div>
                  <div>capabilities: {p.manifest.permissions.capabilities.join(', ')}</div>
                  <div>network: {(p.manifest.permissions.network ?? []).join(', ') || '(none)'}</div>
                  <div>engine: {p.manifest.engine}</div>
                </div>

                {p.manifest.settings && p.manifest.settings.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-medium">Settings (non-secret)</div>
                    <div className="text-[11px] text-slate-500">
                      {p.manifest.settings.map((s) => `${s.key} (${s.type})`).join(', ')}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
                        placeholder='{"default_location":"NYC"}'
                        value={settingsDrafts[p.name] ?? JSON.stringify(p.settings ?? {})}
                        onChange={(e) => setSettingsDrafts((prev) => ({ ...prev, [p.name]: e.target.value }))}
                      />
                      <button onClick={() => saveSettings(p.name)} className="rounded bg-slate-100 px-2 py-1 text-xs">
                        Save
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">Secrets (type secret) are stored in vault as plugin.{p.name}.&lt;key&gt; via /settings/keys</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-10">
        <h2 className="text-lg font-semibold">Marketplace</h2>
        <p className="mb-3 text-xs text-slate-500">
          {market ? (
            <>
              Index: <code>{market.indexUrl}</code> (updated {market.updatedAt}
              {market.fromCache ? ', cached' : ''}). Installs are checksum-verified and land disabled.
            </>
          ) : (
            'Loading the plugin index…'
          )}
        </p>
        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
            placeholder="Search plugins…"
            value={marketQuery}
            onChange={(e) => setMarketQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') loadMarket(marketQuery || undefined);
            }}
          />
          <button onClick={() => loadMarket(marketQuery || undefined)} className="rounded bg-slate-100 px-3 py-1 text-xs">
            Search
          </button>
          <button onClick={() => loadMarket(marketQuery || undefined, true)} className="rounded bg-slate-100 px-3 py-1 text-xs">
            Refresh
          </button>
        </div>
        {marketLoading && <div className="text-sm text-slate-500">Loading…</div>}
        {marketError && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{marketError}</div>}
        {market && !marketLoading && (
          <div className="space-y-3">
            {market.plugins.length === 0 && (
              <div className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">
                No plugins match. Self-host your own index and point MARKETPLACE_INDEX_URL at it.
              </div>
            )}
            {market.plugins.map((entry) => {
              const installed = plugins.find((p) => p.name === entry.name);
              return (
                <div key={entry.name} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">
                        {entry.name}@{entry.version}
                      </div>
                      <div className="text-xs text-slate-500">{entry.description}</div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        capabilities: {entry.manifest.permissions.capabilities.join(', ')} · network:{' '}
                        {(entry.manifest.permissions.network ?? []).join(', ') || '(none)'} · {entry.source.type}
                      </div>
                    </div>
                    {installed ? (
                      <span className="text-xs text-slate-500">
                        installed ({installed.version}){installed.enabled ? ', enabled' : ''}
                      </span>
                    ) : (
                      <button
                        disabled={!!loading}
                        onClick={() => installFromMarketplace(entry.name)}
                        className="rounded bg-slate-900 px-3 py-1 text-xs text-white"
                      >
                        {loading === `${entry.name}:install` ? '...' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-8 rounded bg-amber-50 p-3 text-xs text-amber-800">
        <div className="font-semibold">Security note</div>
        Plugins run in-process. Network is allowlisted; data API is workspace-scoped. Review manifest before enabling. No auto-install. Audit log records install/enable/disable/remove.
      </div>
    </div>
  );
}
