// packages/core/src/graph/import-edges.ts
//
// Two producers of *candidate* (pending) edges:
//   1. LinkedIn CSV "Mutual connections" / "Shared connections" columns —
//      never auto-inserted as confirmed.
//   2. A two-column CSV (`from,to`) for `netpro edge import`.
import Papa from "papaparse";
import type { SqliteConn, PgConn } from "@netpro/db";
import { resolveContactRef } from "../ai/resolve-contact";
import { addEdge, type EdgeRow } from "./edges";
import { GraphError, type GraphOptions } from "./types";

export interface MutualCandidate {
  fromName: string;
  toName: string;
  mutualCount?: number;
}

const MUTUAL_KEYS = [
  "Mutual Connections",
  "Shared Connections",
  "Mutual connections",
  "Shared connections",
];

function mutualField(row: Record<string, string>): string | undefined {
  for (const key of MUTUAL_KEYS) {
    const v = row[key]?.trim();
    if (v) return v;
  }
  for (const [k, v] of Object.entries(row)) {
    if (/mutual|shared connections/i.test(k) && v?.trim()) return v.trim();
  }
  return undefined;
}

function parseMutualList(value: string): { names: string[]; count?: number } {
  const countMatch = value.match(/(\d+)\s*mutual/i);
  const count = countMatch ? Number(countMatch[1]) : undefined;
  const names = value
    .split(/[,;|]/)
    .map((s) => s.replace(/\d+\s*mutual.*/i, "").trim())
    .filter((s) => s.length > 1 && !/^\d+$/.test(s));
  return { names, count };
}

/** Confidence from a reported mutual count: more overlap → higher, capped below 1. */
export function confidenceFromMutuals(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return 0.5;
  return Math.min(0.9, Math.max(0.2, count / 10));
}

/**
 * Walk a LinkedIn-style CSV and emit pending `mutual_network` edges when
 * both names resolve to contacts already in the database. Unmatched names
 * are skipped (not errors) — the owner may not have imported them yet.
 */
export async function ingestMutualCandidates(
  conn: SqliteConn | PgConn,
  csv: string,
  opts: GraphOptions = {},
): Promise<{ candidates: number; inserted: number; skipped: number }> {
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  let candidates = 0;
  let inserted = 0;
  let skipped = 0;

  for (const row of data) {
    const first = row["First Name"]?.trim() ?? "";
    const last = row["Last Name"]?.trim() ?? "";
    const ownerName = `${first} ${last}`.trim() || row["Full Name"]?.trim();
    const mutuals = mutualField(row);
    if (!ownerName || !mutuals) continue;
    const { names, count } = parseMutualList(mutuals);
    if (names.length === 0 && count === undefined) continue;

    let from;
    try {
      from = await resolveContactRef(conn, ownerName, opts.scope);
    } catch {
      skipped++;
      continue;
    }

    const targets = names.length > 0 ? names : [];
    if (targets.length === 0) continue;
    for (const name of targets) {
      candidates++;
      try {
        const to = await resolveContactRef(conn, name, opts.scope);
        const result = await addEdge(
          conn,
          {
            sourceId: from.id,
            targetId: to.id,
            relation: "mutual_network",
            source: "linkedin_csv",
            status: "pending",
            confidence: confidenceFromMutuals(count ?? targets.length),
            context: count
              ? `${count} mutual connections`
              : "shared connections",
          },
          { ...opts, merge: true },
        );
        if (result.created) inserted++;
      } catch {
        skipped++;
      }
    }
  }

  return { candidates, inserted, skipped };
}

export interface ImportEdgesSummary {
  imported: number;
  merged: number;
  errors: Array<{ row: number; reason: string }>;
  edges: EdgeRow[];
}

/**
 * Two-column CSV (`from,to` or `source,target`) of contact selectors.
 * Defaults to confirmed `manual` edges so a curated file is trusted.
 */
export async function importEdgesCsv(
  conn: SqliteConn | PgConn,
  csv: string,
  opts: GraphOptions & {
    relation?: string;
    source?: string;
    status?: string;
  } = {},
): Promise<ImportEdgesSummary> {
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const errors: ImportEdgesSummary["errors"] = [];
  const edges: EdgeRow[] = [];
  let imported = 0;
  let merged = 0;

  for (const [index, row] of data.entries()) {
    const line = index + 2;
    const fromSel = (
      row.from ??
      row.source ??
      row.From ??
      row.Source ??
      ""
    ).trim();
    const toSel = (row.to ?? row.target ?? row.To ?? row.Target ?? "").trim();
    if (!fromSel || !toSel) {
      errors.push({
        row: line,
        reason: "both from and to columns are required",
      });
      continue;
    }
    try {
      const from = await resolveContactRef(conn, fromSel, opts.scope);
      const to = await resolveContactRef(conn, toSel, opts.scope);
      const result = await addEdge(
        conn,
        {
          sourceId: from.id,
          targetId: to.id,
          relation: opts.relation ?? "manual",
          source: opts.source ?? "manual",
          status: opts.status ?? "confirmed",
          confidence: 1,
        },
        { ...opts, merge: true },
      );
      edges.push(result.edge);
      if (result.created) imported++;
      else merged++;
    } catch (e) {
      errors.push({ row: line, reason: (e as Error).message });
    }
  }

  if (data.length === 0) {
    throw new GraphError(
      "invalid_input",
      "CSV is empty or missing a header row (from,to).",
    );
  }

  return { imported, merged, errors, edges };
}
