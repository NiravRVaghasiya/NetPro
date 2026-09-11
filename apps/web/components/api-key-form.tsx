"use client";

// apps/web/components/api-key-form.tsx
//
// "Connect an API": pick a provider, paste a key, Validate & Save. The
// browser never sees a raw stored key — the server answers with masked
// metadata only (`••••1234`, timestamps), and the pasted key is cleared
// from component state the moment a save succeeds (or the provider changes).
// It is never written to localStorage, a URL, or a log.
//
//   GET    /api/credentials                 → providers + vault availability
//   PUT    /api/credentials/:provider       → validate (where safe), then save
//   POST   /api/credentials/:provider/test  → test the stored key
//   DELETE /api/credentials/:provider       → remove the stored key

import { useEffect, useState } from "react";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";

export type CredentialProvider = {
  id: string;
  label: string;
  category: string;
  purpose: string;
  configured: boolean;
  source: "vault" | "env" | "none";
  lastFour: string | null;
  updatedAt: string | null;
  remotelyValidatable: boolean;
  validationNote: string;
};

type CredentialsResponse = {
  vault?: { available?: boolean };
  providers?: CredentialProvider[];
  error?: string;
};

type SaveResponse = {
  provider?: CredentialProvider;
  validated?: boolean;
  warnings?: string[];
  error?: string;
};

type TestResponse = {
  status?: "valid" | "invalid" | "unreachable" | "unsupported";
  message?: string;
  error?: string;
};

type DeleteResponse = {
  provider?: CredentialProvider;
  removed?: boolean;
  message?: string;
  error?: string;
};

type Notice = { tone: "ok" | "info" | "error"; text: string };

const CARD: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "1rem 1.1rem",
  background: "white",
};

const INPUT: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "0.55rem 0.7rem",
  fontSize: "1rem",
  width: "100%",
  boxSizing: "border-box",
};

const LABEL: React.CSSProperties = {
  display: "block",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#374151",
  marginBottom: "0.3rem",
};

const HELP: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "#6b7280",
  marginTop: "0.3rem",
};

const PRIMARY_BUTTON: React.CSSProperties = {
  background: "#111827",
  color: "white",
  borderRadius: 8,
  padding: "0.55rem 1.1rem",
  border: "none",
  fontSize: "1rem",
  minHeight: 44,
  cursor: "pointer",
};

const SECONDARY_BUTTON: React.CSSProperties = {
  background: "white",
  color: "#374151",
  borderRadius: 8,
  padding: "0.55rem 1.1rem",
  border: "1px solid #d1d5db",
  fontSize: "1rem",
  minHeight: 44,
  cursor: "pointer",
};

const CATEGORY_LABELS: Record<string, string> = {
  ai: "AI",
  enrichment: "Enrichment",
  embeddings: "Embeddings",
  content: "Content",
};

const CATEGORY_ORDER = ["ai", "enrichment", "embeddings", "content"];

function NoticeBox({ notice }: { notice: Notice }) {
  const styles =
    notice.tone === "error"
      ? { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }
      : notice.tone === "ok"
        ? { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#15803d" }
        : { background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8" };
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      style={{ ...styles, borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.9rem" }}
    >
      {notice.text}
    </div>
  );
}

export function ApiKeyForm({ serverUrl }: { serverUrl?: string }) {
  const base = serverUrl ?? getServerUrl();
  const [providers, setProviders] = useState<CredentialProvider[] | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("openai");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await serverFetchJson<CredentialsResponse>("/api/credentials", {
          baseUrl: base,
        });
        if (cancelled) return;
        if (!res.ok || !Array.isArray(res.data.providers)) {
          setLoadError(
            res.data.error ?? `Couldn't load integrations from ${base}. Is \`netpro serve\` running?`,
          );
          return;
        }
        setVaultAvailable(res.data.vault?.available ?? false);
        setProviders(res.data.providers);
        if (!res.data.providers.some((p) => p.id === selectedId) && res.data.providers[0]) {
          setSelectedId(res.data.providers[0].id);
        }
      } catch {
        if (!cancelled) {
          setLoadError(
            `NetPro server not reachable at ${base} — run \`netpro serve\` to manage API keys.`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Load once; `base` is stable per deployment.
  }, [base]);

  const selected: CredentialProvider | undefined = (providers ?? []).find(
    (p) => p.id === selectedId,
  );

  function updateProvider(next: CredentialProvider) {
    setProviders((current) =>
      (current ?? []).map((p) => (p.id === next.id ? next : p)),
    );
  }

  function selectProvider(id: string) {
    // Never carry a pasted key across providers.
    setSelectedId(id);
    setKey("");
    setShowKey(false);
    setReplacing(false);
    setConfirmingRemove(false);
    setNotices([]);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy("save");
    setNotices([]);
    try {
      const res = await serverFetchJson<SaveResponse>(
        `/api/credentials/${encodeURIComponent(selected.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: key }),
          baseUrl: base,
        },
      );
      if (!res.ok || !res.data.provider) {
        setNotices([{ tone: "error", text: res.data.error ?? "Couldn't save this key." }]);
        return;
      }
      // The raw key has served its purpose — drop it from state immediately.
      setKey("");
      setShowKey(false);
      setReplacing(false);
      updateProvider(res.data.provider);
      const done: Notice[] = res.data.validated
        ? [{ tone: "ok", text: `✓ Connected — ${selected.label} accepted this key.` }]
        : [
            {
              tone: "info",
              text: `✓ Saved — ${selected.label} is configured. ${res.data.provider.validationNote}`,
            },
          ];
      for (const warning of res.data.warnings ?? []) {
        done.push({ tone: "info", text: warning });
      }
      setNotices(done);
    } catch {
      setNotices([
        {
          tone: "error",
          text: `NetPro server not reachable at ${base} — run \`netpro serve\` and try again.`,
        },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    if (!selected || busy) return;
    setBusy("test");
    setNotices([]);
    try {
      const res = await serverFetchJson<TestResponse>(
        `/api/credentials/${encodeURIComponent(selected.id)}/test`,
        { method: "POST", baseUrl: base },
      );
      if (!res.ok) {
        setNotices([{ tone: "error", text: res.data.error ?? "The test failed." }]);
        return;
      }
      const status = res.data.status ?? "unreachable";
      setNotices([
        {
          tone: status === "valid" ? "ok" : status === "unsupported" ? "info" : "error",
          text:
            status === "valid"
              ? `✓ Connected — ${selected.label} accepted the stored key.`
              : (res.data.message ?? "The test failed."),
        },
      ]);
    } catch {
      setNotices([
        {
          tone: "error",
          text: `NetPro server not reachable at ${base} — run \`netpro serve\` and try again.`,
        },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    if (!selected || busy) return;
    setBusy("delete");
    setNotices([]);
    try {
      const res = await serverFetchJson<DeleteResponse>(
        `/api/credentials/${encodeURIComponent(selected.id)}`,
        { method: "DELETE", baseUrl: base },
      );
      if (!res.ok || !res.data.provider) {
        setNotices([{ tone: "error", text: res.data.error ?? "Couldn't remove this key." }]);
        return;
      }
      setConfirmingRemove(false);
      setReplacing(false);
      updateProvider(res.data.provider);
      setNotices([{ tone: "info", text: res.data.message ?? "Removed the stored key." }]);
    } catch {
      setNotices([
        {
          tone: "error",
          text: `NetPro server not reachable at ${base} — run \`netpro serve\` and try again.`,
        },
      ]);
    } finally {
      setBusy(null);
    }
  }

  const loading = providers === null && loadError === null;
  const stored = selected?.configured === true && selected.source === "vault";
  const showForm = !stored || replacing;
  const saveDisabled =
    busy !== null || loading || !selected || vaultAvailable === false || key.trim() === "";

  return (
    <div style={CARD}>
      <h2 style={{ margin: "0 0 0.2rem", fontSize: "1.05rem" }}>Connect an API</h2>
      <p style={{ margin: "0 0 0.9rem", color: "#6b7280", fontSize: "0.9rem" }}>
        Choose a provider and paste your API key. Your key is stored securely on this machine
        and is only used for the selected integration.
      </p>

      {loadError ? (
        <div role="alert" style={{ marginBottom: "0.8rem" }}>
          <NoticeBox notice={{ tone: "error", text: loadError }} />
        </div>
      ) : null}

      {vaultAvailable === false ? (
        <div style={{ marginBottom: "0.8rem" }}>
          <NoticeBox
            notice={{
              tone: "info",
              text: "API key storage needs one server setting first: set ENCRYPTION_MASTER_KEY (at least 32 characters) on the process running `netpro serve` and restart it. Keys set as environment variables keep working.",
            }}
          />
        </div>
      ) : null}

      <div style={{ display: "grid", gap: "0.8rem" }}>
        <div>
          <label htmlFor="api-key-provider" style={LABEL}>
            Provider
          </label>
          <select
            id="api-key-provider"
            value={selectedId}
            onChange={(e) => selectProvider(e.target.value)}
            disabled={loading}
            style={{ ...INPUT, cursor: loading ? "wait" : "pointer" }}
          >
            {loading ? (
              <option value="openai">Loading providers…</option>
            ) : (
              CATEGORY_ORDER.map((category) => {
                const group = (providers ?? []).filter((p) => p.category === category);
                if (group.length === 0) return null;
                return (
                  <optgroup key={category} label={CATEGORY_LABELS[category] ?? category}>
                    {group.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {p.configured ? " ✓" : ""}
                      </option>
                    ))}
                  </optgroup>
                );
              })
            )}
          </select>
          {selected ? (
            <div style={HELP} aria-live="polite">
              {selected.purpose}
            </div>
          ) : null}
        </div>

        {selected?.source === "env" && !stored ? (
          <NoticeBox
            notice={{
              tone: "info",
              text: `${selected.label} is already configured through a server environment variable. Saving a key here stores it in NetPro instead.`,
            }}
          />
        ) : null}

        {stored && !replacing ? (
          <div
            aria-live="polite"
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "0.7rem 0.8rem",
              background: "#f9fafb",
            }}
          >
            <div style={{ fontSize: "0.8rem", color: "#6b7280", fontWeight: 600 }}>
              API Key
            </div>
            <div style={{ fontSize: "1rem", marginTop: "0.15rem" }} aria-label="API key configured">
              <span aria-hidden>••••••••••••••••••••••</span>
              {selected?.lastFour ?? ""}
            </div>
            <div style={{ color: "#15803d", fontSize: "0.9rem", marginTop: "0.25rem" }}>
              <span aria-hidden>✓</span> Connected
              {selected?.updatedAt ? (
                <span style={{ color: "#6b7280" }}>
                  {" "}
                  · Stored {selected.updatedAt.slice(0, 10)}
                </span>
              ) : null}
            </div>
            {!confirmingRemove ? (
              <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.7rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={SECONDARY_BUTTON}
                  onClick={handleTest}
                  disabled={busy !== null}
                >
                  {busy === "test" ? "Testing…" : "Test Connection"}
                </button>
                <button
                  type="button"
                  style={SECONDARY_BUTTON}
                  onClick={() => {
                    setReplacing(true);
                    setNotices([]);
                  }}
                  disabled={busy !== null}
                >
                  Replace Key
                </button>
                <button
                  type="button"
                  style={{ ...SECONDARY_BUTTON, color: "#991b1b" }}
                  onClick={() => setConfirmingRemove(true)}
                  disabled={busy !== null}
                >
                  Remove
                </button>
              </div>
            ) : (
              <div style={{ marginTop: "0.7rem" }}>
                <p style={{ fontSize: "0.9rem", margin: "0 0 0.6rem" }}>
                  Remove the stored {selected?.label} key?
                </p>
                <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={{ ...PRIMARY_BUTTON, background: "#991b1b" }}
                    onClick={handleRemove}
                    disabled={busy !== null}
                  >
                    {busy === "delete" ? "Removing…" : "Confirm remove"}
                  </button>
                  <button
                    type="button"
                    style={SECONDARY_BUTTON}
                    onClick={() => setConfirmingRemove(false)}
                    disabled={busy !== null}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {showForm ? (
          <form onSubmit={handleSave}>
            <label htmlFor="api-key-value" style={LABEL}>
              API Key
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                id="api-key-value"
                name="apiKey"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-describedby="api-key-help"
                placeholder="Paste your API key"
                style={{ ...INPUT, flex: "1 1 auto", fontFamily: "ui-monospace, monospace" }}
              />
              <button
                type="button"
                style={{ ...SECONDARY_BUTTON, flex: "0 0 auto", padding: "0.55rem 0.8rem" }}
                onClick={() => setShowKey((v) => !v)}
                aria-pressed={showKey}
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <div id="api-key-help" style={HELP}>
              {selected?.remotelyValidatable
                ? "NetPro verifies the key with the provider before saving it."
                : (selected?.validationNote ??
                  "Saved securely on this machine.")}
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.8rem", flexWrap: "wrap" }}>
              <button
                type="submit"
                style={{
                  ...PRIMARY_BUTTON,
                  opacity: saveDisabled ? 0.55 : 1,
                  cursor: saveDisabled ? "not-allowed" : "pointer",
                }}
                disabled={saveDisabled}
              >
                {busy === "save" ? "Validating…" : "Validate & Save"}
              </button>
              {replacing ? (
                <button
                  type="button"
                  style={SECONDARY_BUTTON}
                  onClick={() => {
                    setReplacing(false);
                    setKey("");
                    setNotices([]);
                  }}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        <div style={{ display: "grid", gap: "0.5rem" }} aria-live="polite">
          {notices.map((notice, i) => (
            <NoticeBox key={i} notice={notice} />
          ))}
        </div>
      </div>
    </div>
  );
}
