import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { listEdges, countEdges } from "@netpro/core/src/graph";
import { EdgeActions, AddEdgeForm } from "./panels";

export default async function EdgesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; relation?: string }>;
}) {
  const q = await searchParams;
  const status = q.status?.trim() || undefined;
  const relation = q.relation?.trim() || undefined;
  const scope = await requireScope();
  const [edges, total, pending] = await Promise.all([
    listEdges(conn, { status, relation, limit: 100 }, scope),
    countEdges(conn, { status, relation }, scope),
    countEdges(conn, { status: "pending" }, scope),
  ]);

  return (
    <div>
      <h1>Network edges</h1>
      <p style={{ color: "#475569" }}>
        Graph links between your contacts. Inferred mutuals stay{" "}
        <strong>pending</strong> until you confirm them — NetPro never silently
        claims two people know each other.
      </p>
      <p>
        {total} shown · {pending} pending.{" "}
        <Link href="/edges?status=pending">Review pending</Link>
        {" · "}
        <Link href="/edges">All</Link>
      </p>

      {edges.length === 0 ? (
        <p>
          No edges yet. Add a manual link below, or import a LinkedIn CSV that
          includes a Mutual connections column — candidates appear here for
          confirmation.
        </p>
      ) : (
        <ul style={{ paddingLeft: "1.25rem" }}>
          {edges.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.5rem" }}>
              <Link href={`/contacts/${e.sourceId}`}>{e.sourceName}</Link>
              {" ↔ "}
              <Link href={`/contacts/${e.targetId}`}>{e.targetName}</Link>
              {" · "}
              {e.relation} · {e.status}
              {e.confidence < 1 ? ` · conf ${e.confidence.toFixed(2)}` : ""}
              {e.context ? ` · “${e.context}”` : ""}
              <div style={{ marginTop: "0.25rem" }}>
                <EdgeActions edgeId={e.id} status={e.status} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddEdgeForm />
    </div>
  );
}
