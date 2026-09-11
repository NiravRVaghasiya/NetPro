"use client";

// apps/web/components/add-person-form.tsx
//
// "Add Person" from a single LinkedIn profile URL: Paste → Validate →
// Confirm → Done. The Web UI holds no URL rules of its own — every check
// goes through the local NetPro server, which runs @netpro/core's single
// LinkedIn validator and duplicate detection:
//
//   POST /api/contacts  { linkedinUrl, dryRun: true }  → "Checking profile…"
//   POST /api/contacts  { linkedinUrl, fullName? }     → 201 created / 200 exists
//
// Used on /people (both the header action and the empty state) and embedded
// in the /import flow so a single profile is discoverable there too.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "new"; normalizedUrl: string }
  | { kind: "exists"; contact: { id: string; fullName: string } }
  | { kind: "invalid"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "created"; contact: { id: string; fullName: string } }
  | { kind: "exists"; contact: { id: string; fullName: string } }
  | { kind: "error"; message: string };

type DryRunResponse = {
  profile?: { username?: string; normalizedUrl?: string };
  exists?: boolean;
  contact?: { id: string; fullName: string } | null;
  error?: string;
};

type CreateResponse = {
  status?: "created" | "exists";
  contact?: { id: string; fullName: string; linkedinUrl?: string | null };
  error?: string;
};

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
  textDecoration: "none",
  display: "inline-block",
  textAlign: "center",
  boxSizing: "border-box",
};

export function AddPersonForm({
  variant = "default",
  defaultExpanded = false,
  serverUrl,
}: {
  /** `empty` renders the "Build your network" empty state instead of the button. */
  variant?: "default" | "empty";
  /** Start with the form open (used when embedded in the import flow). */
  defaultExpanded?: boolean;
  /** Server base URL override (tests). */
  serverUrl?: string;
}) {
  const base = serverUrl ?? getServerUrl();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [serverDown, setServerDown] = useState(false);
  const requestId = useRef(0);

  // Live validation, debounced: every keystroke settles into one dry-run
  // against the server's validator — the browser never judges URLs itself.
  useEffect(() => {
    if (!expanded) return;
    const value = url.trim();
    if (value === "") {
      setCheck({ kind: "idle" });
      return;
    }
    setCheck({ kind: "checking" });
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await serverFetchJson<DryRunResponse>(
            "/api/contacts",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ linkedinUrl: value, dryRun: true }),
              baseUrl: base,
            },
          );
          if (requestId.current !== id) return;
          setServerDown(false);
          if (!res.ok) {
            setCheck({
              kind: "invalid",
              message: res.data.error ?? "That URL couldn't be checked. Try again.",
            });
            return;
          }
          if (res.data.exists && res.data.contact) {
            setCheck({ kind: "exists", contact: res.data.contact });
          } else {
            setCheck({
              kind: "new",
              normalizedUrl: res.data.profile?.normalizedUrl ?? value,
            });
          }
        } catch {
          if (requestId.current !== id) return;
          setServerDown(true);
          setCheck({ kind: "idle" });
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [url, expanded, base]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submit.kind === "adding") return;
    setSubmit({ kind: "adding" });
    try {
      const res = await serverFetchJson<CreateResponse>("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linkedinUrl: url.trim(),
          ...(name.trim() === "" ? {} : { fullName: name.trim() }),
        }),
        baseUrl: base,
      });
      setServerDown(false);
      if (!res.ok || !res.data.contact) {
        setSubmit({
          kind: "error",
          message: res.data.error ?? "Couldn't add this person. Try again.",
        });
        return;
      }
      const contact = { id: res.data.contact.id, fullName: res.data.contact.fullName };
      setSubmit(
        res.data.status === "exists"
          ? { kind: "exists", contact }
          : { kind: "created", contact },
      );
    } catch {
      setServerDown(true);
      setSubmit({
        kind: "error",
        message: `NetPro server not reachable at ${base} — run \`netpro serve\` and try again.`,
      });
    }
  }

  function reset() {
    setUrl("");
    setName("");
    setCheck({ kind: "idle" });
    setSubmit({ kind: "idle" });
  }

  if (!expanded) {
    if (variant === "empty") {
      return (
        <div style={{ ...CARD, textAlign: "center", padding: "2rem 1.5rem", marginTop: "0.85rem" }}>
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.25rem" }}>Build your network</h2>
          <p style={{ margin: "0 0 1.1rem", color: "#6b7280", fontSize: "0.95rem" }}>
            Add your first person with a LinkedIn profile link, or import your connections.
          </p>
          <div style={{ display: "flex", gap: "0.6rem", justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" style={PRIMARY_BUTTON} onClick={() => setExpanded(true)}>
              Add LinkedIn Profile
            </button>
            <Link href="/import" style={SECONDARY_BUTTON}>
              Import Data
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div style={{ marginTop: "0.85rem" }}>
        <button type="button" style={PRIMARY_BUTTON} onClick={() => setExpanded(true)}>
          + Add Person
        </button>
      </div>
    );
  }

  const done = submit.kind === "created" || submit.kind === "exists";
  const submitDisabled =
    submit.kind === "adding" ||
    check.kind === "checking" ||
    check.kind === "invalid" ||
    check.kind === "exists" ||
    url.trim() === "";

  return (
    <div style={{ ...CARD, marginTop: "0.85rem" }}>
      <h2 style={{ margin: "0 0 0.2rem", fontSize: "1.05rem" }}>Add to NetPro</h2>
      <p style={{ margin: "0 0 0.9rem", color: "#6b7280", fontSize: "0.9rem" }}>
        Paste a LinkedIn profile URL — NetPro checks it and adds the person to your network.
      </p>

      {serverDown ? (
        <div
          role="alert"
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            borderRadius: 8,
            padding: "0.5rem 0.8rem",
            marginBottom: "0.8rem",
            fontSize: "0.9rem",
          }}
        >
          NetPro server not reachable at <code>{base}</code> — run{" "}
          <code>netpro serve</code> to add people.
        </div>
      ) : null}

      {done ? (
        <div aria-live="polite">
          <p style={{ margin: "0 0 0.8rem", fontSize: "0.95rem" }}>
            {submit.kind === "created" ? (
              <>
                <span aria-hidden>✓</span> <strong>{submit.contact.fullName}</strong> is now
                in your network.
              </>
            ) : (
              <>This person is already in your network.</>
            )}
          </p>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <Link
              href={`/people/${submit.contact.id}`}
              style={{ ...PRIMARY_BUTTON, textDecoration: "none", display: "inline-block" }}
            >
              View Person
            </Link>
            <button type="button" style={SECONDARY_BUTTON} onClick={reset}>
              Add another
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="add-person-linkedin-url" style={LABEL}>
              LinkedIn profile URL
            </label>
            <input
              id="add-person-linkedin-url"
              name="linkedinUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://www.linkedin.com/in/username"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setSubmit({ kind: "idle" });
              }}
              aria-describedby="add-person-url-help add-person-url-status"
              style={INPUT}
            />
            <div id="add-person-url-help" style={HELP}>
              A profile link like <code>https://www.linkedin.com/in/username</code> — company
              and jobs pages aren&apos;t supported.
            </div>
            <div
              id="add-person-url-status"
              aria-live="polite"
              style={{ minHeight: "1.5rem", marginTop: "0.35rem", fontSize: "0.9rem" }}
            >
              {check.kind === "checking" ? (
                <span style={{ color: "#6b7280" }}>Checking profile…</span>
              ) : check.kind === "new" ? (
                <span style={{ color: "#15803d" }}>
                  <span aria-hidden>✓</span> Profile found — not in your network yet.
                </span>
              ) : check.kind === "exists" ? (
                <span>
                  This person is already in your network.{" "}
                  <Link
                    href={`/people/${check.contact.id}`}
                    style={{ color: "#2563eb", fontWeight: 600 }}
                  >
                    View Person
                  </Link>
                </span>
              ) : check.kind === "invalid" ? (
                <span role="alert" style={{ color: "#991b1b" }}>
                  {check.message}
                </span>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: "0.7rem" }}>
            <label htmlFor="add-person-name" style={LABEL}>
              Name <span style={{ fontWeight: 400, color: "#6b7280" }}>(optional)</span>
            </label>
            <input
              id="add-person-name"
              name="fullName"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-describedby="add-person-name-help"
              style={INPUT}
            />
            <div id="add-person-name-help" style={HELP}>
              Leave blank to use the LinkedIn profile name.
            </div>
          </div>

          {submit.kind === "error" ? (
            <div
              role="alert"
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                borderRadius: 8,
                padding: "0.5rem 0.8rem",
                marginTop: "0.8rem",
                fontSize: "0.9rem",
              }}
            >
              {submit.message}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
            <button
              type="submit"
              style={{
                ...PRIMARY_BUTTON,
                opacity: submitDisabled ? 0.55 : 1,
                cursor: submitDisabled ? "not-allowed" : "pointer",
              }}
              disabled={submitDisabled}
            >
              {submit.kind === "adding" ? "Adding…" : "Add Person"}
            </button>
            {variant === "default" && !defaultExpanded ? (
              <button
                type="button"
                style={SECONDARY_BUTTON}
                onClick={() => {
                  reset();
                  setExpanded(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
