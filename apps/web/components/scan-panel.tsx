"use client";

// apps/web/components/scan-panel.tsx
//
// Phase 14 — Scan Visualization. Renders the plan's SCAN mockup:
//
//   Source                    ← result.source
//   Progress                  ← job progress + scan.progress SSE
//   Processed  X / Y          ← result.processed / result.total
//   New contacts              ← result.newContacts
//   Updated contacts          ← result.updatedContacts
//   Relationships discovered  ← result.relationshipsDiscovered
//   Enrichment                ← result.enrichment.progress
//
// The panel is a visualization only: every number comes from the server's
// scan job (job.metadata.result), and live updates arrive via the SSE event
// stream — the same stream a CLI-triggered `netpro scan` publishes to.

import { useMemo, useState } from "react";
import Link from "next/link";
import { serverFetchJson } from "@/lib/netpro-server";
import { useNetProEvents } from "@/hooks/use-netpro-events";

export type ScanResult = {
  source: string;
  processed: number;
  total: number;
  newContacts: number;
  updatedContacts: number;
  relationships: number;
  relationshipsDiscovered: number;
  communities: number;
  enrichment: {
    configured: boolean;
    enriched: number;
    progress: number;
    skipped: number;
    error: string | null;
  };
  index: {
    scanned: number;
    indexed: number;
    skipped: number;
    pruned: number;
    keywordIndexAvailable: boolean;
  };
  startedAt: string | null;
  completedAt: string | null;
};

export type ScanJob = {
  id: string;
  type: string;
  status: string;
  progress: number;
  startedAt?: string | null;
  completedAt?: string | null;
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

function ProgressBar({ value, color = "#2563eb" }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div style={{ height: 10, background: "#f3f4f6", borderRadius: 999, overflow: "hidden", flex: 1 }}>
      <div style={{ height: 10, width: `${pct}%`, background: color, borderRadius: 999, transition: "width 0.4s ease" }} />
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...CARD, flex: "1 1 130px", minWidth: 130 }}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: 750, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      {hint ? <div style={{ fontSize: "0.72rem", color: "#9ca3af", marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

export function ScanPanel({
  serverUrl,
  initialJob,
  initialResult,
  enrichmentConfigured,
}: {
  serverUrl: string;
  initialJob: ScanJob | null;
  initialResult: ScanResult | null;
  enrichmentConfigured: boolean;
}) {
  const [job, setJob] = useState<ScanJob | null>(initialJob);
  const [result, setResult] = useState<ScanResult | null>(initialResult);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { events, connected } = useNetProEvents({
    serverUrl,
    types: [
      "scan.started",
      "scan.progress",
      "scan.completed",
      "enrichment.started",
      "enrichment.completed",
      "job.completed",
      "job.failed",
    ],
    jobId: job?.id,
    history: 40,
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

  async function startScan() {
    setStarting(true);
    setError(null);
    try {
      const res = await serverFetchJson<{ job?: ScanJob; result?: ScanResult; error?: string }>("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "linkedin_csv", origin: "web" }),
      });
      if (!res.ok || !res.data.job) {
        setError((res.data.error as string) ?? "Scan failed to start.");
        return;
      }
      setJob(res.data.job);
      setResult(res.data.result ?? null);
    } catch (e) {
      setError(`NetPro server not reachable at ${serverUrl} — run \`netpro serve\`: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  // Phase 16 — the interface that started the job rides along in its
  // metadata, so the Web UI can say where a scan came from and prove both
  // clients produce the same job.
  const origin =
    typeof job?.metadata?.origin === "string" ? (job.metadata.origin as string) : null;

  const isRunning = job?.status === "running" || job?.status === "queued";
  const color = isRunning ? "#2563eb" : job?.status === "failed" ? "#dc2626" : "#16a34a";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
        <button
          type="button"
          onClick={() => void startScan()}
          disabled={starting || isRunning}
          style={{
            background: isRunning ? "#6b7280" : "#111827",
            color: "white",
            border: "none",
            borderRadius: 8,
            padding: "0.5rem 1rem",
            fontSize: "0.9rem",
            fontWeight: 600,
            cursor: isRunning ? "not-allowed" : "pointer",
          }}
        >
          {starting ? "Starting…" : isRunning ? "Scanning…" : "Start scan"}
        </button>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.8rem",
            color: connected ? "#16a34a" : "#92400e",
            background: connected ? "#f0fdf4" : "#fffbeb",
            border: `1px solid ${connected ? "#bbf7d0" : "#fde68a"}`,
            borderRadius: 999,
            padding: "0.2rem 0.6rem",
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: connected ? "#16a34a" : "#f59e0b", display: "inline-block" }} />
          {connected ? "Live — SSE connected" : "SSE connecting…"}
        </span>
        <span style={{ color: "#6b7280", fontSize: "0.8rem", marginLeft: "auto" }}>
          or run <code>netpro scan</code> in a terminal — it appears here live.
        </span>
      </div>

      {error ? (
        <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 10, padding: "0.6rem 0.9rem", marginBottom: "0.85rem", fontSize: "0.9rem" }}>
          {error}
        </div>
      ) : null}

      {job || result ? (
        <div>
          {/* Source + Progress (the plan's top strip) */}
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
              <div style={{ fontSize: "0.9rem", fontWeight: 700 }}>SCAN</div>
              <span style={{ fontSize: "0.8rem", color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                {job ? `${job.status} · job ${job.id.slice(0, 8)}` : "completed"}
              </span>
              {job ? (
                <span
                  style={{
                    fontSize: "0.72rem",
                    color: origin === "cli" ? "#1d4ed8" : "#6b7280",
                    background: origin === "cli" ? "#eff6ff" : "#f9fafb",
                    border: `1px solid ${origin === "cli" ? "#bfdbfe" : "#e5e7eb"}`,
                    borderRadius: 999,
                    padding: "0.1rem 0.5rem",
                  }}
                >
                  {origin === "cli"
                    ? "started in a terminal — netpro scan"
                    : origin === "web"
                      ? "started here"
                      : "job"}
                </span>
              ) : null}
            </div>
            <div style={{ marginTop: "0.7rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.8rem", color: "#6b7280" }}>
                <span>
                  Source: <strong style={{ color: "#374151" }}>{result?.source ?? "linkedin_csv"}</strong>
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{liveProgress}%</span>
              </div>
              <div style={{ marginTop: "0.4rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <ProgressBar value={liveProgress} color={color} />
                <span style={{ fontSize: "0.85rem", color: "#374151", fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>{liveProgress}%</span>
              </div>
              {liveMessage ? <div style={{ color: "#6b7280", fontSize: "0.82rem", marginTop: "0.4rem" }}>{liveMessage}</div> : null}
            </div>
          </div>

          {/* Metrics */}
          <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", marginTop: "0.85rem" }}>
            <Metric
              label="Processed"
              value={`${result?.processed ?? 0} / ${result?.total ?? 0}`}
              hint="contacts scanned of total"
            />
            <Metric label="New contacts" value={String(result?.newContacts ?? 0)} hint="index docs written" />
            <Metric label="Updated contacts" value={String(result?.updatedContacts ?? 0)} hint="enriched this scan" />
            <Metric
              label="Relationships discovered"
              value={String(result?.relationshipsDiscovered ?? 0)}
              hint={`${result?.relationships ?? 0} confirmed edges`}
            />
            <Metric label="Communities" value={String(result?.communities ?? 0)} hint="Louvain" />
          </div>

          {/* Enrichment — the plan's second progress strip */}
          <div style={{ ...CARD, marginTop: "0.85rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.8rem", color: "#6b7280" }}>
              <span>
                Enrichment{" "}
                {result?.enrichment.configured ? (
                  <span style={{ color: "#16a34a", fontWeight: 600 }}>configured</span>
                ) : (
                  <span style={{ color: "#9ca3af" }}>not configured — skipped</span>
                )}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {result?.enrichment.enriched ?? 0} enriched · {result?.enrichment.progress ?? 0}%
              </span>
            </div>
            <div style={{ marginTop: "0.4rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <ProgressBar value={result?.enrichment.progress ?? 0} color={result?.enrichment.configured ? "#9333ea" : "#d1d5db"} />
              <span style={{ fontSize: "0.85rem", color: "#374151", fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>
                {result?.enrichment.progress ?? 0}%
              </span>
            </div>
            {result?.enrichment.error ? (
              <div style={{ color: "#dc2626", fontSize: "0.8rem", marginTop: "0.4rem" }}>{result.enrichment.error}</div>
            ) : null}
            <div style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "0.4rem" }}>
              Search index: {result?.index.scanned ?? 0} scanned · {result?.index.indexed ?? 0} written · {result?.index.skipped ?? 0} unchanged
              {result?.index.keywordIndexAvailable ? " · FTS available" : ""}
            </div>
          </div>

          {result?.completedAt ? (
            <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.6rem" }}>
              Completed {new Date(result.completedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      ) : (
        <div style={{ ...CARD, color: "#9ca3af", fontSize: "0.9rem" }}>
          No scan has run yet. Start one above, or run <code>netpro scan</code> in a terminal.
          <div style={{ marginTop: 8 }}>
            <Link href="/activity" style={{ color: "#2563eb", fontSize: "0.85rem" }}>
              See all scan jobs in Activity →
            </Link>
          </div>
        </div>
      )}

      {!enrichmentConfigured ? (
        <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "0.6rem" }}>
          Tip: enrichment providers (Hunter, PDL, Clearbit) are optional — NetPro scans fully offline. Configure keys in{" "}
          <Link href="/settings/keys" style={{ color: "#2563eb" }}>
            Settings → Keys
          </Link>{" "}
          to enrich contacts during a scan.
        </p>
      ) : null}
    </div>
  );
}
