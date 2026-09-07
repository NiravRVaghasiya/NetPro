"use client";

import { useState } from "react";

interface ContactHit {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  role: string | null;
}

interface Draft {
  subject: string;
  body: string;
  provider: string;
  model: string;
  tone: string;
  generatedAt: string;
}

const TONES = ["professional", "warm", "casual", "friendly"] as const;

export interface OutreachComposerInitial {
  /** Pre-selected recipient (v2.0 Phase 3: the graph page's "draft intro"). */
  initialContact?: ContactHit;
  initialContext?: string;
  initialPurpose?: string;
  /** Pre-picked tone for intro asks; the composer still validates it. */
  initialTone?: (typeof TONES)[number];
}

export default function OutreachComposer({
  initialContact,
  initialContext,
  initialPurpose,
  initialTone,
}: OutreachComposerInitial = {}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [selected, setSelected] = useState<ContactHit | null>(initialContact ?? null);
  const [searching, setSearching] = useState(false);

  const [adhoc, setAdhoc] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
  });
  const [mode, setMode] = useState<"contact" | "adhoc">("contact");
  const [tone, setTone] = useState<(typeof TONES)[number]>(initialTone ?? "professional");
  const [context, setContext] = useState(initialContext ?? "");
  const [purpose, setPurpose] = useState(initialPurpose ?? "");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function searchContacts(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(value)}&limit=8`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        results?: ContactHit[];
        contacts?: ContactHit[];
      };
      setHits((data.results ?? data.contacts ?? []).slice(0, 8));
    } finally {
      setSearching(false);
    }
  }

  function copy(text: string, which: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    setDraft(null);
    try {
      const payload =
        mode === "contact" && selected
          ? { contactId: selected.id }
          : {
              recipient: {
                name: adhoc.name || undefined,
                email: adhoc.email || undefined,
                company: adhoc.company || undefined,
                role: adhoc.role || undefined,
              },
            };

      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          tone,
          context: context || undefined,
          purpose: purpose || undefined,
        }),
      });
      const body = (await res.json()) as {
        subject?: string;
        body?: string;
        provider?: string;
        model?: string;
        tone?: string;
        generatedAt?: string;
        error?: string;
        code?: string;
      };

      if (!res.ok) {
        if (body.code === "ai_not_configured") {
          setNotConfigured(true);
        }
        setError(body.error ?? "Generation failed");
        return;
      }
      setDraft(body as unknown as Draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const canGenerate =
    mode === "contact"
      ? Boolean(selected)
      : Boolean(adhoc.name.trim() || adhoc.email.trim());

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: 720 }}>
      <p style={{ color: "#555" }}>
        NetPro drafts the message — <strong>you</strong> review and send it.
        Pick a contact or describe the recipient, add context, and generate a
        personalized draft.
      </p>

      {notConfigured && (
        <div
          style={{
            border: "1px solid #f59e0b",
            background: "#fffbeb",
            padding: "0.75rem 1rem",
            borderRadius: 8,
          }}
          role="alert"
        >
          <strong>AI provider not configured.</strong> Set{" "}
          <code>OPENAI_API_KEY</code> (or <code>ANTHROPIC_API_KEY</code> +{" "}
          <code>AI_PROVIDER=anthropic</code>) on the server, then reload. See{" "}
          <a href="/settings">settings</a>.
        </div>
      )}

      <div>
        <div
          style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}
        >
          <button
            type="button"
            onClick={() => setMode("contact")}
            style={{ fontWeight: mode === "contact" ? 700 : 400 }}
          >
            From my contacts
          </button>
          <button
            type="button"
            onClick={() => setMode("adhoc")}
            style={{ fontWeight: mode === "adhoc" ? 700 : 400 }}
          >
            Someone new
          </button>
        </div>

        {mode === "contact" ? (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {selected ? (
              <div
                style={{
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>
                  <strong>{selected.fullName}</strong>
                  {selected.company ? ` · ${selected.company}` : ""}
                  {selected.role ? ` · ${selected.role}` : ""}
                  {selected.email ? ` · ${selected.email}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setHits([]);
                    setQuery("");
                  }}
                >
                  Clear
                </button>
              </div>
            ) : (
              <>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => void searchContacts(e.target.value)}
                  placeholder="Search contacts by name, company, email…"
                  aria-label="Search contacts"
                  style={{ width: "100%", padding: "0.5rem" }}
                />
                {searching && <span style={{ color: "#777" }}>Searching…</span>}
                {hits.length > 0 && (
                  <ul
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                    }}
                  >
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(h);
                            setHits([]);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "0.5rem 1rem",
                            background: "none",
                            border: 0,
                            borderBottom: "1px solid hsl(var(--border))",
                            cursor: "pointer",
                          }}
                        >
                          <strong>{h.fullName}</strong>
                          {h.company ? ` · ${h.company}` : ""}
                          {h.role ? ` · ${h.role}` : ""}
                          {h.email ? ` · ${h.email}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
            }}
          >
            <input
              placeholder="Name"
              value={adhoc.name}
              onChange={(e) => setAdhoc({ ...adhoc, name: e.target.value })}
              style={{ padding: "0.5rem" }}
            />
            <input
              placeholder="Email"
              type="email"
              value={adhoc.email}
              onChange={(e) => setAdhoc({ ...adhoc, email: e.target.value })}
              style={{ padding: "0.5rem" }}
            />
            <input
              placeholder="Company"
              value={adhoc.company}
              onChange={(e) => setAdhoc({ ...adhoc, company: e.target.value })}
              style={{ padding: "0.5rem" }}
            />
            <input
              placeholder="Role"
              value={adhoc.role}
              onChange={(e) => setAdhoc({ ...adhoc, role: e.target.value })}
              style={{ padding: "0.5rem" }}
            />
          </div>
        )}
      </div>

      <div style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          Tone{" "}
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value as (typeof TONES)[number])}
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <textarea
          placeholder="Context: how you know them, what prompted this (e.g. “met at React Conf after the WASM talk”)"
          value={context}
          maxLength={2000}
          onChange={(e) => setContext(e.target.value)}
          rows={3}
          style={{ padding: "0.5rem", width: "100%" }}
        />
        <textarea
          placeholder="The ask (e.g. “a 15-minute call about collaborating on an OSS project”)"
          value={purpose}
          maxLength={500}
          onChange={(e) => setPurpose(e.target.value)}
          rows={2}
          style={{ padding: "0.5rem", width: "100%" }}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading || !canGenerate}
        >
          {loading ? "Generating…" : "Generate draft"}
        </button>
        {!canGenerate && (
          <span
            style={{
              marginLeft: "0.75rem",
              color: "#777",
              fontSize: "0.85rem",
            }}
          >
            pick a contact or fill in a name/email
          </span>
        )}
      </div>

      {error && !notConfigured && (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      )}

      {draft && (
        <div
          style={{
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            padding: "1rem",
            display: "grid",
            gap: "0.75rem",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong>Subject</strong>
              <button
                type="button"
                onClick={() => copy(draft.subject, "subject")}
              >
                {copied === "subject" ? "Copied!" : "Copy"}
              </button>
            </div>
            <p style={{ margin: "0.25rem 0 0" }}>{draft.subject}</p>
          </div>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong>Body</strong>
              <button
                type="button"
                onClick={() => copy(`${draft.subject}\n\n${draft.body}`, "all")}
              >
                {copied === "all" ? "Copied!" : "Copy all"}
              </button>
            </div>
            <p style={{ whiteSpace: "pre-wrap", margin: "0.25rem 0 0" }}>
              {draft.body}
            </p>
          </div>
          <p style={{ color: "#777", fontSize: "0.8rem", margin: 0 }}>
            Drafted by {draft.provider}/{draft.model} · tone: {draft.tone} ·
            review before sending
          </p>
        </div>
      )}
    </div>
  );
}
