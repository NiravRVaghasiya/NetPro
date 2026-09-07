// Test-only helpers for graph analytics: build a LoadedGraph from plain
// tuples without touching the database, so algorithm tests stay pure.
import { buildGraph, type EdgeReadRow, type GraphContactRow, type LoadedGraph } from './analysis';

export interface TestEdgeSpec {
  sourceId: string;
  targetId: string;
  relation?: string;
  bidirectional?: boolean;
  confidence?: number;
  strength?: number;
  status?: string;
  id?: string;
}

export function testContact(id: string, extra: Partial<GraphContactRow> = {}): GraphContactRow {
  return {
    id,
    fullName: `Contact ${id}`,
    company: null,
    industry: null,
    role: null,
    relationshipScore: null,
    lastInteraction: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

export function testEdge(sourceId: string, targetId: string, extra: Partial<TestEdgeSpec> = {}): EdgeReadRow {
  return {
    id: extra.id ?? `edge-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    relation: extra.relation ?? 'manual',
    strength: extra.strength ?? 0.5,
    confidence: extra.confidence ?? 1,
    bidirectional: extra.bidirectional ?? true,
  };
}

/** Build a LoadedGraph from ids + edge specs (contacts auto-created). */
export function graphOf(
  contactIds: string[],
  edges: Array<[string, string] | TestEdgeSpec>,
  contactMeta: Record<string, Partial<GraphContactRow>> = {}
): LoadedGraph {
  const contacts = contactIds.map((id) => testContact(id, contactMeta[id] ?? {}));
  const rows = edges.map((e, i) => {
    if (Array.isArray(e)) return testEdge(e[0], e[1], { id: `edge-${i}` });
    return testEdge(e.sourceId, e.targetId, { ...e, id: e.id ?? `edge-${i}` });
  });
  return buildGraph(rows, contacts);
}
