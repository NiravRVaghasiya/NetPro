// apps/cli/src/commands/edge.ts
//
// `netpro edge` — graph provenance from the terminal.
//   netpro edge add <from> <to> [--relation] [--at]
//   netpro edge list [--contact] [--relation]
//   netpro edge rm <edgeId>
//   netpro edge import <csv>
//   netpro edge merge
//   netpro edge confirm|reject <edgeId>
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveContactRef } from '@netpro/core/src/ai';
import {
  addEdge,
  importEdgesCsv,
  listEdges,
  mergeSymmetricPairs,
  removeEdge,
  resolveEdgeId,
  setEdgeStatus,
  type EdgeWithNames,
} from '@netpro/core/src/graph';

export interface EdgeAddOptions {
  relation?: string;
  source?: string;
  context?: string;
  confidence?: string;
  at?: string;
  json?: boolean;
}

export interface EdgeListOptions {
  contact?: string;
  relation?: string;
  status?: string;
  limit?: string;
  json?: boolean;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--limit must be a positive number, got "${value}"`);
  }
  return Math.min(Math.floor(n), 200);
}

export function renderEdgeLine(e: EdgeWithNames): string {
  const conf = e.confidence < 1 ? ` · conf ${e.confidence.toFixed(2)}` : '';
  return `  ${e.sourceName} ↔ ${e.targetName} · ${e.relation} · ${e.status}${conf}  [${e.id.slice(0, 8)}]`;
}

export async function executeEdgeAdd(
  fromSel: string,
  toSel: string,
  opts: EdgeAddOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const from = await resolveContactRef(conn, fromSel);
  const to = await resolveContactRef(conn, toSel);
  const result = await addEdge(
    conn,
    {
      sourceId: from.id,
      targetId: to.id,
      relation: opts.relation,
      source: opts.source ?? 'manual',
      context: opts.context,
      confidence: opts.confidence !== undefined ? Number(opts.confidence) : undefined,
      status: 'confirmed',
    },
    { now }
  );
  if (opts.json) return JSON.stringify(result, null, 2);
  return `✓ Linked ${from.fullName} ↔ ${to.fullName} (${result.edge.relation}, ${result.edge.status})  [${result.edge.id.slice(0, 8)}]`;
}

export async function executeEdgeList(
  opts: EdgeListOptions,
  conn: SqliteConn | PgConn
): Promise<string> {
  const contactId = opts.contact
    ? (await resolveContactRef(conn, opts.contact)).id
    : undefined;
  const edges = await listEdges(conn, {
    contactId,
    relation: opts.relation,
    status: opts.status,
    limit: parseLimit(opts.limit),
  });
  if (opts.json) return JSON.stringify(edges, null, 2);
  if (edges.length === 0) {
    return 'No edges yet — add one with: netpro edge add "Ada Lovelace" "Bob Builder" --relation colleague';
  }
  return [`Graph edges (${edges.length}):`, ...edges.map(renderEdgeLine)].join('\n');
}

export async function executeEdgeRm(
  idOrPrefix: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn
): Promise<string> {
  const id = await resolveEdgeId(conn, idOrPrefix);
  const removed = await removeEdge(conn, id);
  if (opts.json) return JSON.stringify(removed, null, 2);
  return `✗ Removed edge ${removed.id.slice(0, 8)} (${removed.relation}).`;
}

export async function executeEdgeImport(
  path: string,
  opts: { json?: boolean; relation?: string },
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const csv = readFileSync(path, 'utf-8');
  const summary = await importEdgesCsv(conn, csv, { now, relation: opts.relation });
  if (opts.json) return JSON.stringify(summary, null, 2);
  const lines = [`✓ Imported ${summary.imported} edges (${summary.merged} merged)`];
  if (summary.errors.length > 0) {
    lines.push(`  ${summary.errors.length} row(s) skipped:`);
    summary.errors.forEach((e) => lines.push(`    row ${e.row}: ${e.reason}`));
  }
  return lines.join('\n');
}

export async function executeEdgeMerge(
  opts: { json?: boolean },
  conn: SqliteConn | PgConn
): Promise<string> {
  const result = await mergeSymmetricPairs(conn);
  if (opts.json) return JSON.stringify(result, null, 2);
  return `✓ Collapsed ${result.merged} symmetric pair${result.merged === 1 ? '' : 's'}.`;
}

export async function executeEdgeStatus(
  idOrPrefix: string,
  status: 'confirmed' | 'rejected',
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  now: Date = new Date()
): Promise<string> {
  const id = await resolveEdgeId(conn, idOrPrefix);
  const edge = await setEdgeStatus(conn, id, status, { now });
  if (opts.json) return JSON.stringify(edge, null, 2);
  return `✓ Edge ${edge.id.slice(0, 8)} is now ${edge.status}.`;
}

async function run(fn: (conn: SqliteConn | PgConn) => Promise<string>): Promise<void> {
  const { openDb } = await import('../db');
  try {
    console.log(await fn(await openDb()));
  } catch (e) {
    console.error(`netpro edge: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerEdgeCommand(program: Command): void {
  const edge = program.command('edge').description('Manage graph edges between contacts');

  edge
    .command('add <from> <to>')
    .description('Link two contacts (confirmed, undoable)')
    .option('--relation <rel>', 'mutual_network | colleague | met_at_event | mutual_intro | manual', 'manual')
    .option('--source <src>', 'linkedin_csv | manual | event_import | skype_migrate', 'manual')
    .option('--context <text>', 'Free-text note (e.g. event name)')
    .option('--confidence <n>', '0–1 (default 1 for manual)')
    .option('--at <iso>', 'Discovered-at timestamp (unused; kept for flag parity)')
    .option('--json', 'Print the result as JSON')
    .action((from: string, to: string, opts: EdgeAddOptions) =>
      run((conn) => executeEdgeAdd(from, to, opts, conn))
    );

  edge
    .command('list')
    .description('List graph edges')
    .option('--contact <selector>', 'Filter to one contact')
    .option('--relation <rel>', 'Filter by relation')
    .option('--status <status>', 'pending | confirmed | rejected')
    .option('--limit <n>', 'Max rows (default 50)', '50')
    .option('--json', 'Print the result as JSON')
    .action((opts: EdgeListOptions) => run((conn) => executeEdgeList(opts, conn)));

  edge
    .command('rm <edgeId>')
    .description('Remove an edge (full id or unique prefix)')
    .option('--json', 'Print the result as JSON')
    .action((id: string, opts: { json?: boolean }) => run((conn) => executeEdgeRm(id, opts, conn)));

  edge
    .command('import <csv>')
    .description('Import a two-column CSV (from,to) of contact selectors')
    .option('--relation <rel>', 'Relation for every row (default manual)')
    .option('--json', 'Print the result as JSON')
    .action((csv: string, opts: { json?: boolean; relation?: string }) =>
      run((conn) => executeEdgeImport(csv, opts, conn))
    );

  edge
    .command('merge')
    .description('Collapse symmetric A→B / B→A pairs')
    .option('--json', 'Print the result as JSON')
    .action((opts: { json?: boolean }) => run((conn) => executeEdgeMerge(opts, conn)));

  edge
    .command('confirm <edgeId>')
    .description('Confirm a pending inferred edge')
    .option('--json', 'Print the result as JSON')
    .action((id: string, opts: { json?: boolean }) =>
      run((conn) => executeEdgeStatus(id, 'confirmed', opts, conn))
    );

  edge
    .command('reject <edgeId>')
    .description('Reject a pending inferred edge')
    .option('--json', 'Print the result as JSON')
    .action((id: string, opts: { json?: boolean }) =>
      run((conn) => executeEdgeStatus(id, 'rejected', opts, conn))
    );
}
