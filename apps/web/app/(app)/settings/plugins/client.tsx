'use client';

import { useState } from 'react';

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

interface Props {
  initialPlugins: PluginItem[];
  workspaceId: string;
  role: string;
}

export default function PluginsClient({ initialPlugins, workspaceId: _workspaceId, role: _role }: Props) {
  const [plugins, setPlugins] = useState(initialPlugins);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, string>>({});

  async function callAction(name: string, action: string, body?: Record<string, unknown>) {
    setLoading(`${name}:${action}`);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to ${action} ${name}`);
      } else {
        // Refresh list
        const listRes = await fetch('/api/plugins');
        if (listRes.ok) {
          const list = await listRes.json();
          setPlugins(list);
        }
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function removePlugin(name: string) {
    if (!confirm(`Remove plugin ${name}? This will delete its files from DB (not from disk).`)) return;
    setLoading(`${name}:remove`);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) setError(data.error || `Failed to remove ${name}`);
      else {
        const listRes = await fetch('/api/plugins');
        if (listRes.ok) {
          const list = await listRes.json();
          setPlugins(list);
        }
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

  return (
    <div>
      {error && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {plugins.length === 0 ? (
        <div className="rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
          No plugins installed. Install via CLI: <code>netpro plugin install ./plugins/example-event-discovery/manifest.json</code> then enable after reviewing permissions.
          <div className="mt-3">
            Example plugin <code>example-event-discovery</code> is available in <code>plugins/</code> and exercises event-discovery + command capabilities.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {plugins.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{p.name}@{p.version}</div>
                  <div className="text-xs text-slate-500">{p.manifest.description ?? ''}</div>
                  <div className="mt-1 text-xs">
                    <span className={p.enabled ? 'text-green-700' : 'text-slate-500'}>{p.enabled ? 'enabled' : 'disabled'}</span>
                    {p.installedFrom && <span className="ml-2 text-slate-400">from {p.installedFrom}</span>}
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
                      onClick={() => callAction(p.name, 'enable', { reviewed: true })}
                      className="rounded bg-emerald-600 px-3 py-1 text-xs text-white"
                    >
                      {loading === `${p.name}:enable` ? '...' : 'Enable'}
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
          ))}
        </div>
      )}

      <div className="mt-8 rounded bg-amber-50 p-3 text-xs text-amber-800">
        <div className="font-semibold">Security note</div>
        Plugins run in-process. Network is allowlisted; data API is workspace-scoped. Review manifest before enabling. No auto-install. Audit log records install/enable/disable/remove.
      </div>
    </div>
  );
}
