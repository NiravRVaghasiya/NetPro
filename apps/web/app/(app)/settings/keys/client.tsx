"use client";
import { useState, type FormEvent } from "react";

type KeyInfo = {
  keyName: string;
  userId: string | null;
  lastFour: string;
  updatedAt: string;
  lastUsedAt: string | null;
};
export default function KeysClient({
  initialKeys,
  writable,
  admin,
  slots,
}: {
  initialKeys: KeyInfo[];
  writable: boolean;
  admin: boolean;
  slots: string[];
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [keyName, setKeyName] = useState(slots[0] ?? "outreach.openai");
  const [target, setTarget] = useState("personal");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function send(method: string, name: string, destination: string) {
    setBusy(true);
    setMessage("");
    const value = secret;
    setSecret(""); // Never keep a submitted key in UI state, even after failure.
    try {
      const response = await fetch("/api/settings/keys", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyName: name,
          target: destination,
          ...(method === "POST" ? { secret: value } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Unable to update credential.");
      const refreshed = await fetch("/api/settings/keys", {
        cache: "no-store",
      });
      if (!refreshed.ok)
        throw new Error(
          "Saved, but unable to refresh status. Reload this page.",
        );
      setKeys((await refreshed.json()).keys);
      setMessage(
        method === "POST" ? "Credential saved." : "Credential removed.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send("POST", keyName, target);
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Provider keys</h1>
      <p>
        Personal credentials override workspace credentials, then server
        environment settings. Stored keys are encrypted and cannot be displayed
        again.
      </p>
      {!writable && (
        <p role="status">
          Read-only. An operator must configure ENCRYPTION_MASTER_KEY, and your
          role must allow credential changes.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4 rounded-xl border p-5">
        <label className="block">
          Provider slot
          <select
            className="ml-3 rounded border p-2"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
          >
            {slots.map((slot) => (
              <option key={slot}>{slot}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Store for
          <select
            className="ml-3 rounded border p-2"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="personal">Just me</option>
            {admin && <option value="workspace">Workspace (shared)</option>}
          </select>
        </label>
        <label className="block">
          Credential
          <input
            className="ml-3 rounded border p-2"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            minLength={8}
            maxLength={4096}
            required
            disabled={!writable || busy}
          />
        </label>
        <button
          className="rounded bg-emerald-800 px-4 py-2 text-white disabled:opacity-50"
          disabled={!writable || busy}
        >
          Save credential
        </button>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <h2 className="text-lg font-semibold">Saved credentials</h2>
      {keys.length === 0 && (
        <p>No vault keys saved. Server environment credentials still work.</p>
      )}
      <ul className="space-y-3">
        {keys.map((key) => (
          <li
            className="rounded border p-4"
            key={`${key.keyName}:${key.userId ?? "workspace"}`}
          >
            <strong>{key.keyName}</strong> ·{" "}
            {key.userId === null ? "Workspace" : "Personal"} · ••••
            {key.lastFour}
            <p className="text-sm">
              Last used: {key.lastUsedAt ?? "Not used yet"} · Updated:{" "}
              {key.updatedAt}
            </p>
            <button
              className="mt-2 underline disabled:opacity-50"
              disabled={!writable || busy || (key.userId === null && !admin)}
              onClick={() =>
                void send(
                  "DELETE",
                  key.keyName,
                  key.userId === null ? "workspace" : "personal",
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        Content API adapters remain disabled until implemented; saving
        credentials does not enable them. CLI credentials remain in your local
        encrypted keychain.
      </p>
    </div>
  );
}
