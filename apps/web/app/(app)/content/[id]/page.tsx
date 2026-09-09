// apps/web/app/(app)/content/[id]/page.tsx
//
// One piece of content: the working link, its latest snapshot and the
// snapshot series (a server-rendered table — no chart library), the contacts
// it involves, and the panels that keep the numbers honest. The engine never
// guesses: a snapshot is a row the owner (or, later, an enabled provider)
// recorded, and `null` renders as "—" because it means "the platform did not
// report this", never zero.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  getContentItem,
  getContentMetricsSeries,
  listContentMentions,
  resolveContentRef,
} from "@netpro/core/src/content";
import { relativeDayLabel, utcDay } from "@/lib/format";
import { formatCount, platformLabel } from "@/lib/content";
import {
  AddMentionForm,
  RecordMetricsForm,
  RemoveContentButton,
  RemoveMentionButton,
} from "../panels";

function MetricCell({ value }: { value: number | null }) {
  return (
    <td style={{ padding: "0.4rem 0.5rem" }}>
      {value === null ? (
        <span style={{ color: "#9ca3af" }}>—</span>
      ) : (
        formatCount(value)
      )}
    </td>
  );
}

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await requireScope();
  const item = await resolveContentRef(conn, id, scope).catch(() => null);
  if (!item) notFound();
  const [detail, series, mentions] = await Promise.all([
    getContentItem(conn, item.id, scope),
    getContentMetricsSeries(conn, item.id, { scope }),
    listContentMentions(conn, item.id, scope),
  ]);
  if (!detail) notFound();
  const now = new Date();
  const latest = detail.latestMetrics;

  return (
    <div>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/content">← Content</Link>
      </p>
      <h1>{detail.title}</h1>
      <p style={{ margin: "0.25rem 0" }}>
        <a href={detail.url} target="_blank" rel="noopener noreferrer">
          {detail.url}
        </a>
      </p>
      <p style={{ margin: "0.25rem 0", color: "#475569" }}>
        {platformLabel(detail.platform)}
        {detail.type ? ` · ${detail.type}` : ""}
        {detail.author ? ` · by ${detail.author}` : ""} · source {detail.source}
        {detail.publishedAt ? (
          <>
            {" "}
            · published {utcDay(detail.publishedAt)} (
            {relativeDayLabel(detail.publishedAt, now)})
          </>
        ) : null}
      </p>
      {detail.tags.length > 0 ? (
        <p style={{ margin: "0.25rem 0", color: "#6b7280" }}>
          tags: {detail.tags.map((t) => `#${t}`).join(" ")}
        </p>
      ) : null}
      {detail.summary ? (
        <p style={{ margin: "0.5rem 0", color: "#374151" }}>{detail.summary}</p>
      ) : null}

      <section style={{ marginTop: "1rem" }} aria-label="Latest snapshot">
        <h2 style={{ fontSize: "1rem" }}>Latest snapshot</h2>
        {latest ? (
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}
              >
                {["views", "likes", "comments", "shares", "bookmarks"].map(
                  (h) => (
                    <th key={h} style={{ padding: "0.4rem 0.5rem" }}>
                      {h}
                    </th>
                  ),
                )}
                <th style={{ padding: "0.4rem 0.5rem" }}>measured</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <MetricCell value={latest.views} />
                <MetricCell value={latest.likes} />
                <MetricCell value={latest.comments} />
                <MetricCell value={latest.shares} />
                <MetricCell value={latest.bookmarks} />
                <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>
                  {utcDay(latest.fetchedAt)} (
                  {relativeDayLabel(latest.fetchedAt, now)}) · {latest.source}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p style={{ color: "#9ca3af" }}>
            No snapshots yet — add the first numbers below. Empty cells mean the
            platform does not report that figure, not zero.
          </p>
        )}
      </section>

      <RecordMetricsForm contentId={detail.id} />

      <section style={{ marginTop: "1.75rem" }} aria-label="Snapshot history">
        <h2 style={{ fontSize: "1rem" }}>
          History
          {series && series.metrics.length > 0
            ? ` (${series.metrics.length} shown of ${series.total})`
            : ""}
        </h2>
        {series && series.metrics.length > 0 ? (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr
                style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}
              >
                <th style={{ padding: "0.4rem 0.5rem" }}>Measured</th>
                {["views", "likes", "comments", "shares", "bookmarks"].map(
                  (h) => (
                    <th key={h} style={{ padding: "0.4rem 0.5rem" }}>
                      {h}
                    </th>
                  ),
                )}
                <th style={{ padding: "0.4rem 0.5rem" }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {series.metrics.map((m) => (
                <tr key={m.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>
                    {utcDay(m.fetchedAt)}
                  </td>
                  <MetricCell value={m.views} />
                  <MetricCell value={m.likes} />
                  <MetricCell value={m.comments} />
                  <MetricCell value={m.shares} />
                  <MetricCell value={m.bookmarks} />
                  <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>
                    {m.source}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "#9ca3af" }}>Nothing recorded yet.</p>
        )}
      </section>

      <section style={{ marginTop: "1.75rem" }} aria-label="Who is in it">
        <h2 style={{ fontSize: "1rem" }}>
          Contacts{mentions.length > 0 ? ` (${mentions.length})` : ""}
        </h2>
        {mentions.length === 0 ? (
          <p style={{ color: "#9ca3af", margin: "0 0 0.25rem" }}>
            Nobody linked yet — mention a contact when this piece is theirs
            (co-authored, featured, reviewed…).
          </p>
        ) : (
          <ul style={{ margin: "0.25rem 0", paddingLeft: "1.25rem" }}>
            {mentions.map((m) => (
              <li
                key={`${m.contentId}-${m.contactId}`}
                style={{ marginBottom: "0.4rem" }}
              >
                <Link href={`/contacts/${encodeURIComponent(m.contactId)}`}>
                  {m.fullName}
                </Link>
                {m.email ? (
                  <span style={{ color: "#6b7280" }}> · {m.email}</span>
                ) : null}
                {m.context ? (
                  <span style={{ color: "#374151" }}> — {m.context}</span>
                ) : null}{" "}
                <RemoveMentionButton
                  contentId={detail.id}
                  contactId={m.contactId}
                  name={m.fullName}
                />
              </li>
            ))}
          </ul>
        )}
        <AddMentionForm contentId={detail.id} />
      </section>

      <section aria-label="Danger zone" style={{ marginTop: "1.5rem" }}>
        <RemoveContentButton contentId={detail.id} />
      </section>
    </div>
  );
}
