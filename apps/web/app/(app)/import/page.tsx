"use client";

// apps/web/app/(app)/import/page.tsx
//
// Phase 15 — the import experience: Upload → Preview → Validate → Import.
//
// The Web UI is a client of the local NetPro server, never the backend. This
// page has no import logic of its own:
//
//   * Upload   — pick/drop a LinkedIn connections CSV.
//   * Preview  — POST /api/import/preview, which runs core's `previewImport`
//                (parse + validate, no database writes).
//   * Validate — the preview's per-row issues are exactly the rows the import
//                will skip, because CLI and Web share one normalization path.
//   * Import   — POST /api/import, which wraps the same `runImport` the CLI
//                uses in a Job and streams progress via SSE.
//
// No duplicate importer: `netpro import linkedin.csv` and this page both
// execute @netpro/core/src/import through the server's job system.

import { useMemo, useState } from "react";
import Link from "next/link";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { useNetProEvents } from "@/hooks/use-netpro-events";
import { AddPersonForm } from "@/components/add-person-form";

type ImportPreview = {
  source: string;
  columns: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  issues: Array<{ row: number; reason: string }>;
  issuesTruncated: boolean;
  contacts: Array<{
    row: number;
    fullName: string;
    company?: string;
    role?: string;
    email?: string;
    location?: string;
    connectedOn?: string;
    valid: boolean;
    issue?: string;
  }>;
  truncated: boolean;
};

type ImportSummary = {
  imported: number;
  merged: number;
  errors: Array<{ row: number; reason: string }>;
  edgeCandidates?: { candidates: number; inserted: number; skipped: number };
};

type ImportJob = {
  id: string;
  type: string;
  status: string;
  progress: number;
  metadata: Record<string, unknown>;
};

const CARD: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "1rem 1.1rem",
  background: "white",
};

const LABEL: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "#6b7280",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  fontWeight: 600,
};

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.75rem",
        fontWeight: 600,
        color: ok ? "#16a34a" : "#b45309",
        background: ok ? "#f0fdf4" : "#fffbeb",
        border: `1px solid ${ok ? "#bbf7d0" : "#fde68a"}`,
        borderRadius: 999,
        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

export default function ImportPage() {
  const serverUrl = getServerUrl();
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live progress for the in-flight import job (SSE). The server completes
  // imports synchronously today, but a CLI-triggered import — or a future
  // async worker — appears here too.
  const { events, connected } = useNetProEvents({
    serverUrl,
    jobId: job?.id,
    history: 50,
    enabled: Boolean(job?.id),
  });

  const liveProgress = useMemo(() => {
    let p = job?.progress ?? 0;
    for (const e of events) {
      if (typeof e.progress === "number" && Number.isFinite(e.progress)) p = Math.max(p, e.progress);
    }
    return Math.max(0, Math.min(100, Math.round(p)));
  }, [events, job?.progress]);

  const liveMessage = useMemo(() => {
    const msgs = events.filter((e) => typeof e.message === "string").map((e) => String(e.message));
    return msgs[msgs.length - 1] ?? null;
  }, [events]);

  async function readCsv(file: File): Promise<string> {
    return file.text();
  }

  async function handleFile(file: File) {
    setError(null);
    setSummary(null);
    setJob(null);
    setFileName(file.name);

    if (!/\.csv$/i.test(file.name) && file.type && !file.type.includes("csv")) {
      // Non-CSV file — still attempt a parse below, but warn early.
    }

    let text: string;
    try {
      text = await readCsv(file);
    } catch (e) {
      setError(`Could not read ${file.name}: ${(e as Error).message}`);
      return;
    }
    setCsv(text);

    setBusy("preview");
    try {
      const res = await serverFetchJson<{ preview?: ImportPreview; error?: string }>("/api/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      if (!res.ok || !res.data.preview) {
        setError((res.data.error as string) ?? "Preview failed.");
        return;
      }
      setPreview(res.data.preview);
    } catch (e) {
      setError(
        `NetPro server not reachable at ${serverUrl} — run \`netpro serve\` to preview and import. (${(e as Error).message})`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleImport() {
    if (!csv) return;
    setError(null);
    setBusy("import");
    try {
      const res = await serverFetchJson<{ job?: ImportJob; summary?: ImportSummary; error?: string }>(
        "/api/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv }),
        },
      );
      if (!res.ok || !res.data.summary) {
        setError((res.data.error as string) ?? "Import failed.");
        return;
      }
      setJob(res.data.job ?? null);
      setSummary(res.data.summary);
    } catch (e) {
      setError(`Import failed — server unreachable at ${serverUrl}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const dropzone = (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
      }}
      style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: "2.2rem", textAlign: "center", background: "#f8fafc" }}
    >
      <p style={{ margin: 0, color: "#374151" }}>
        Drag a LinkedIn connections CSV here, or{" "}
        <label style={{ color: "#2563eb", cursor: "pointer", fontWeight: 600 }}>
          browse
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </label>
      </p>
      <p style={{ margin: "0.5rem 0 0", color: "#9ca3af", fontSize: "0.85rem" }}>
        LinkedIn exports a CSV from Settings &amp; Privacy → “Get a copy of your data”. The same file works with{" "}
        <code>netpro import linkedin.csv</code>.
      </p>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Import</h1>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>Upload → Preview → Validate → Import, through the local NetPro server.</span>
        <Link href="/activity" style={{ marginLeft: "auto", fontSize: "0.85rem", color: "#2563eb" }}>
          View activity →
        </Link>
      </div>

      {error ? (
        <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 10, padding: "0.6rem 0.9rem", marginTop: "0.9rem", fontSize: "0.9rem" }}>
          {error}
        </div>
      ) : null}

      {/* Step 1 — Upload */}
      <section style={{ marginTop: "1.15rem" }}>
        <div style={LABEL}>1 · Upload</div>
        {dropzone}
        {busy === "preview" ? <p style={{ color: "#6b7280", marginTop: "0.5rem" }}>Previewing…</p> : null}
        <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: "0.9rem" }}>
          Adding just one person? Paste their LinkedIn profile URL instead — the same check
          the People page uses:
        </p>
        <AddPersonForm defaultExpanded />
      </section>

      {/* Steps 2–3 — Preview + Validate */}
      {preview ? (
        <section style={{ marginTop: "1.15rem" }}>
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
              <div style={LABEL}>2 · Preview</div>
              <div style={LABEL}>3 · Validate</div>
              <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>{fileName}</span>
            </div>

            <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", marginTop: "0.8rem" }}>
              <div style={{ ...CARD, flex: "1 1 120px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Rows</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750 }}>{preview.totalRows}</div>
              </div>
              <div style={{ ...CARD, flex: "1 1 120px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Will import</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750, color: "#16a34a" }}>{preview.validRows}</div>
              </div>
              <div style={{ ...CARD, flex: "1 1 120px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Will be skipped</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750, color: preview.invalidRows > 0 ? "#b45309" : "#16a34a" }}>
                  {preview.invalidRows}
                </div>
              </div>
            </div>

            <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "0.6rem" }}>
              Columns detected: <code>{preview.columns.join(", ")}</code>
            </p>

            {/* Preview table */}
            <div style={{ overflowX: "auto", marginTop: "0.6rem" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Row</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Name</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Company</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Role</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Connected</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.contacts.map((c) => (
                    <tr key={c.row} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "0.4rem 0.5rem", fontFamily: "ui-monospace, monospace" }}>{c.row}</td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>{c.fullName || "—"}</td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>{c.company ?? "—"}</td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>{c.role ?? "—"}</td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>{c.connectedOn ?? "—"}</td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {c.valid ? <Pill ok>✓ import</Pill> : <Pill ok={false}>✗ {c.issue}</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.truncated ? (
                <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.4rem" }}>
                  Showing the first {preview.contacts.length} of {preview.totalRows} rows.
                </p>
              ) : null}
            </div>

            {/* Validation issues */}
            {preview.invalidRows > 0 ? (
              <div style={{ marginTop: "0.8rem" }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 650, color: "#92400e" }}>
                  Validation — {preview.invalidRows} row(s) will be skipped:
                </div>
                <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#78350f" }}>
                  {preview.issues.map((issue, i) => (
                    <li key={`${issue.row}-${i}`}>
                      row {issue.row}: {issue.reason}
                    </li>
                  ))}
                  {preview.issuesTruncated ? <li>… and more</li> : null}
                </ul>
              </div>
            ) : (
              <p style={{ marginTop: "0.8rem", color: "#16a34a", fontSize: "0.9rem" }}>
                ✓ All {preview.totalRows} row(s) are valid and will be imported.
              </p>
            )}

            {/* Step 4 — Import */}
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={busy === "import" || preview.validRows === 0}
                style={{
                  background: "#111827",
                  color: "white",
                  border: "none",
                  borderRadius: 8,
                  padding: "0.5rem 1rem",
                  fontSize: "0.9rem",
                  fontWeight: 600,
                  cursor: preview.validRows === 0 ? "not-allowed" : "pointer",
                  opacity: preview.validRows === 0 ? 0.5 : 1,
                }}
              >
                {busy === "import" ? "Importing…" : `Import ${preview.validRows} contact(s)`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setSummary(null);
                  setJob(null);
                  setFileName(null);
                }}
                style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.5rem 0.9rem", fontSize: "0.9rem", background: "white", cursor: "pointer" }}
              >
                Choose another file
              </button>
              <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>
                Runs the same <code>runImport</code> as <code>netpro import</code>, as a server job.
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {/* Step 4 result */}
      {summary ? (
        <section style={{ marginTop: "1.15rem" }}>
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
              <div style={LABEL}>4 · Imported</div>
              {job ? <span style={{ color: "#6b7280", fontSize: "0.8rem", fontFamily: "ui-monospace, monospace" }}>job {job.id.slice(0, 8)}</span> : null}
              {connected ? (
                <Pill ok>live via SSE</Pill>
              ) : (
                <span style={{ color: "#9ca3af", fontSize: "0.78rem" }}>SSE connecting…</span>
              )}
            </div>

            <div style={{ marginTop: "0.6rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              <div style={{ height: 8, background: "#f3f4f6", borderRadius: 999, overflow: "hidden", flex: "1 1 240px" }}>
                <div style={{ height: 8, width: `${liveProgress}%`, background: summary ? "#16a34a" : "#2563eb", borderRadius: 999, transition: "width 0.4s ease" }} />
              </div>
              <span style={{ fontSize: "0.85rem", color: "#374151", fontVariantNumeric: "tabular-nums" }}>{liveProgress}%</span>
            </div>
            {liveMessage ? <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "0.4rem" }}>{liveMessage}</p> : null}

            <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
              <div style={{ ...CARD, flex: "1 1 110px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>New contacts</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750 }}>{summary.imported}</div>
              </div>
              <div style={{ ...CARD, flex: "1 1 110px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Updated</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750 }}>{summary.merged}</div>
              </div>
              <div style={{ ...CARD, flex: "1 1 110px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Relationships</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750 }}>{summary.edgeCandidates?.inserted ?? 0}</div>
              </div>
              <div style={{ ...CARD, flex: "1 1 110px", padding: "0.8rem 1rem", marginTop: 0 }}>
                <div style={LABEL}>Skipped</div>
                <div style={{ fontSize: "1.5rem", fontWeight: 750, color: summary.errors.length > 0 ? "#b45309" : "#16a34a" }}>{summary.errors.length}</div>
              </div>
            </div>

            <p style={{ color: "#374151", marginTop: "0.7rem" }}>
              ✓ Imported {summary.imported} contact(s) ({summary.merged} merged)
              {summary.edgeCandidates && summary.edgeCandidates.inserted > 0
                ? ` — ${summary.edgeCandidates.inserted} mutual-network relationship(s) queued for confirmation`
                : ""}
              {summary.errors.length > 0 ? ` — ${summary.errors.length} row(s) skipped` : ""}
            </p>

            <div style={{ marginTop: "0.7rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <Link href="/observatory" style={{ fontSize: "0.85rem", color: "#2563eb", border: "1px solid #dbeafe", background: "#eff6ff", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}>
                Observatory →
              </Link>
              <Link href="/activity" style={{ fontSize: "0.85rem", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}>
                View this job in Activity →
              </Link>
              <button type="button" onClick={() => { setSummary(null); setJob(null); setPreview(null); setFileName(null); }} style={{ fontSize: "0.85rem", color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", background: "white", cursor: "pointer" }}>
                Import another file
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
