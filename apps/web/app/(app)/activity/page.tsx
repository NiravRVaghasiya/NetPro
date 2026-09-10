// @ts-nocheck
// apps/web/app/(app)/activity/page.tsx
//
// Phase 8/14 — Activity: make NetPro's work observable.
//
// The plan (Phase 7) says every long-running operation is a Job the UI can
// observe; Phase 8 makes it realtime via SSE. This page is the union:
//
//   * a server-fetched Jobs table (GET /api/jobs) so the page is meaningful
//     even before the SSE connects,
//   * a live ActivityFeed (useNetProEvents → EventSource /api/events) that
//     streams scan.progress, import.completed, relationship.discovered, etc.,
//   * and a job-progress strip that visualizes the plan's 0→15→40→70→90→100
//     ladder as a bar, not as a stale poll.
//
// CLI ↔ Web UI integration (Phase 16): `netpro scan` in a terminal posts to
// the same server, so its job.* events appear here without a refresh.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { ActivityFeed } from "@/components/activity-feed";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";

export const metadata = { title: "Activity — NetPro" };

type Job = {
  id: string;
  type: string;
  status: string;
  progress: number;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
};

function statusColor(s: string): string {
  if (s === "completed") return "#16a34a";
  if (s === "running") return "#2563eb";
  if (s === "queued") return "#f59e0b";
  if (s === "failed") return "#dc2626";
  if (s === "cancelled") return "#6b7280";
  return "#64748b";
}

function JobRow({ job }: { job: Job }) {
  const started = job.startedAt ?? job.started_at ?? job.createdAt ?? job.created_at ?? null;
  const completed = job.completedAt ?? job.completed_at ?? null;
  return (
    <tr>
      <td style={{ padding: "0.5rem 0.6rem", fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}>
        <Link href={`/activity?jobId=${encodeURIComponent(job.id)}`} style={{ color: "#2563eb" }}>
          {job.id.slice(0, 8)}
        </Link>
      </td>
      <td style={{ padding: "0.5rem 0.6rem" }}>{job.type}</td>
      <td style={{ padding: "0.5rem 0.6rem" }}>
        <span
          style={{
            display: "inline-block",
            fontSize: "0.75rem",
            fontWeight: 600,
            color: "white",
            background: statusColor(job.status),
            borderRadius: 999,
            padding: "0.15rem 0.5rem",
          }}
        >
          {job.status}
        </span>
      </td>
      <td style={{ padding: "0.5rem 0.6rem", minWidth: 140 }}>
        <div style={{ height: 6, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
          <div
            style={{
              height: 6,
              width: `${Math.max(0, Math.min(100, job.progress))}%`,
              background: statusColor(job.status),
              borderRadius: 999,
            }}
          />
        </div>
        <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{job.progress}%</span>
      </td>
      <td style={{ padding: "0.5rem 0.6rem", fontSize: "0.8rem", color: "#6b7280" }}>
        {started ? new Date(started).toLocaleString() : "—"}
      </td>
      <td style={{ padding: "0.5rem 0.6rem", fontSize: "0.8rem", color: "#6b7280" }}>
        {completed ? new Date(completed).toLocaleString() : "—"}
      </td>
      <td style={{ padding: "0.5rem 0.6rem", fontSize: "0.8rem", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
        {job.error ? <span style={{ color: "#dc2626" }}>{job.error.slice(0, 120)}</span> : JSON.stringify(job.metadata).slice(0, 80)}
      </td>
    </tr>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireScope();
  const sp = await searchParams;
  const jobIdFilter = typeof sp.jobId === "string" ? sp.jobId : Array.isArray(sp.jobId) ? sp.jobId[0] : undefined;
  const typeFilter = typeof sp.type === "string" ? sp.type : undefined;
  const serverUrl = getServerUrl();

  let jobs: Job[] = [];
  let total = 0;
  let reachable = false;
  try {
    const qs = new URLSearchParams();
    qs.set("limit", "30");
    if (typeFilter) qs.set("type", typeFilter);
    const res = await serverFetchJson<{ jobs: Job[]; total: number }>(`/api/jobs?${qs.toString()}`);
    if (res.ok) {
      jobs = res.data.jobs as Job[];
      total = res.data.total;
      reachable = true;
    }
  } catch {
    reachable = false;
  }

  return (
    <div>
      <h1 style={{ margin: 0 }}>Activity</h1>
      <p style={{ color: "#6b7280", marginTop: "0.35rem" }}>
        Every NetPro operation — import, scan, enrich, index, embed, graph, analyze — is a{" "}
        <code>Job</code> the UI can observe. Long-running work streams progress via{" "}
        <code>GET /api/events</code> (Server-Sent Events). Start a scan from{" "}
        <Link href="/observatory" style={{ color: "#2563eb" }}>
          Observatory
        </Link>{" "}
        or <code>netpro scan</code> and watch it here live.
      </p>

      {!reachable ? (
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            borderRadius: 10,
            padding: "0.6rem 0.9rem",
            marginTop: "0.75rem",
          }}
        >
          Server not reachable at <code>{serverUrl}</code> — jobs list and live events need{" "}
          <code>netpro serve</code>. The feed below will stay in &quot;Connecting…&quot; until the server is up.
        </div>
      ) : null}

      <section style={{ marginTop: "1.25rem" }}>
        <h2>Jobs</h2>
        {jobs.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>
            No jobs yet.{" "}
            <Link href="/import" style={{ color: "#2563eb" }}>
              Import a CSV
            </Link>{" "}
            or POST to <code>/api/scan</code>, <code>/api/import</code>, <code>/api/enrich</code> from the CLI.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Job</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Type</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Status</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Progress</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Started</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Completed</th>
                  <th style={{ padding: "0.5rem 0.6rem" }}>Meta / error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </tbody>
            </table>
            <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.4rem" }}>Showing {jobs.length} of {total} jobs.</p>
          </div>
        )}
      </section>

      <section style={{ marginTop: "1.5rem", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
        <h2 style={{ margin: "0 0 0.6rem" }}>Live event stream</h2>
        <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: 0 }}>
          Server-Sent Events from <code>{serverUrl}/api/events</code> — scan.progress, import.completed, relationship.discovered,
          graph.updated, enrichment.*, job.failed, … The same stream a CLI-triggered <code>netpro scan</code> publishes to, so the
          Web UI visualizes terminal work without polling.
        </p>
        <ActivityFeed serverUrl={serverUrl} types={typeFilter ? [typeFilter] : undefined} jobId={jobIdFilter} maxItems={120} />
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <Link
            href="/activity"
            style={{ fontSize: "0.85rem", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
          >
            All
          </Link>
          <Link
            href="/activity?type=scan"
            style={{ fontSize: "0.85rem", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
          >
            Scan
          </Link>
          <Link
            href="/activity?type=import"
            style={{ fontSize: "0.85rem", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
          >
            Import
          </Link>
          <Link
            href="/activity?type=job"
            style={{ fontSize: "0.85rem", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
          >
            Jobs
          </Link>
        </div>
      </section>
    </div>
  );
}
