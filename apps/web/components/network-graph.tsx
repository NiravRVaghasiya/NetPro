// apps/web/components/network-graph.tsx
//
// Phase 11 — Network visualization: the graph as the visual centerpiece.
//
// From the plan:
//   Show: people, relationships, relationship strength, communities,
//   clusters, bridges, high-degree nodes, important intermediaries.
//   The UI must consume graph results from `packages/core` without
//   reimplementing graph algorithms. Louvain, degree/Brandes, and
//   pathfinding remain backend-only.
//
// This component is purely presentational: it receives the
// `GraphVisualization` payload from GET /api/graph/visualization
// (which itself is core-orchestrated) and turns it into an interactive
// SVG. Physics is browser-only and does not rederive communities or
// centrality — it just lays out the already-annotated nodes for
// inspection. One operation, one job system, one event stream.

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

// Palette — categorical, color-blind friendly (Okabe-Ito + extras)
const PALETTE = [
  '#2563eb', // blue
  '#16a34a', // green
  '#9333ea', // purple
  '#ea580c', // orange
  '#0891b2', // cyan
  '#dc2626', // red
  '#ca8a04', // amber
  '#4f46e5', // indigo
  '#0d9488', // teal
  '#db2777', // pink
  '#65a30d', // lime
  '#7c3aed', // violet
];

function communityColor(id: number): string {
  return PALETTE[((id % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}

export type VizNode = {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  communityId: number;
  communityLabel: string;
  degree: number;
  betweenness: number | null;
};

export type VizEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: number;
  confidence: number;
  bidirectional: boolean;
};

export type VisualizationPayload = {
  nodes: VizNode[];
  edges: VizEdge[];
  meta: {
    totalNodes: number;
    totalEdges: number;
    shownNodes: number;
    shownEdges: number;
    truncated: boolean;
    truncatedReason: string | null;
    communities: number;
    modularity: number;
    pendingCandidates?: number;
    degraded?: { reason: string } | null;
    coverage?: number;
  };
};

type Pos = { x: number; y: number; vx: number; vy: number };

type Transform = { x: number; y: number; k: number };

function scoreLabel(v: number | null): string {
  if (v === null || v === undefined) return '—';
  return v.toFixed(2);
}

export function NetworkGraphView({
  data,
  serverUrl,
  onSelectPath,
}: {
  data: VisualizationPayload;
  serverUrl?: string;
  onSelectPath?: (targetId: string, sourceId?: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 860, h: 520 });
  const [filterRelation, setFilterRelation] = useState<string>('');
  const [minStrength, setMinStrength] = useState(0);
  const [communityFilter, setCommunityFilter] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [showLabels, setShowLabels] = useState(true);
  const [paused, setPaused] = useState(false);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [panning, setPanning] = useState<{ active: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // triggers render clock for CSS transition debugging

  // Build adjacency for highlights
  const idToNode = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const degrees = useMemo(() => new Map(data.nodes.map((n) => [n.id, n.degree])), [data.nodes]);

  // Identify bridges / hubs (top 7 by betweenness / degree) for decoration
  const hubs = useMemo(() => {
    return [...data.nodes].sort((a, b) => b.degree - a.degree).slice(0, 7);
  }, [data.nodes]);
  const bridges = useMemo(() => {
    return [...data.nodes]
      .filter((n) => n.betweenness !== null)
      .sort((a, b) => (b.betweenness ?? 0) - (a.betweenness ?? 0))
      .slice(0, 7);
  }, [data.nodes]);
  const bridgeSet = useMemo(() => new Set(bridges.map((n) => n.id)), [bridges]);
  const hubSet = useMemo(() => new Set(hubs.map((n) => n.id)), [hubs]);

  // Unique communities for legend + filter
  const communities = useMemo(() => {
    const m = new Map<number, { label: string; count: number; members: string[] }>();
    for (const n of data.nodes) {
      const e = m.get(n.communityId);
      if (e) { e.count++; e.members.push(n.fullName); }
      else m.set(n.communityId, { label: n.communityLabel, count: 1, members: [n.fullName] });
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count);
  }, [data.nodes]);

  // Filtered edges
  const visibleEdges = useMemo(() => {
    return data.edges.filter((e) => {
      if (filterRelation && e.relation !== filterRelation) return false;
      if (e.strength < minStrength) return false;
      if (communityFilter !== null) {
        const s = idToNode.get(e.source);
        const t = idToNode.get(e.target);
        if (!s || !t) return false;
        if (s.communityId !== communityFilter && t.communityId !== communityFilter) return false;
      }
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const s = idToNode.get(e.source);
        const t = idToNode.get(e.target);
        const hits = (n?: VizNode) => n && (n.fullName.toLowerCase().includes(q) || n.company?.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
        if (!hits(s) && !hits(t)) return false;
      }
      return true;
    });
  }, [data.edges, filterRelation, minStrength, communityFilter, query, idToNode]);

  const visibleNodeIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of visibleEdges) { s.add(e.source); s.add(e.target); }
    // If query filters nodes without edges, keep matching nodes
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      for (const n of data.nodes) {
        if (n.fullName.toLowerCase().includes(q) || n.company?.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) s.add(n.id);
      }
    } else if (visibleEdges.length === 0 && !filterRelation && minStrength === 0 && communityFilter === null) {
      // No filters: show all
      return new Set(data.nodes.map((n) => n.id));
    }
    // When filters hide all edges, show still the filtered community nodes
    if (communityFilter !== null && s.size === 0) {
      for (const n of data.nodes) if (n.communityId === communityFilter) s.add(n.id);
    }
    return s;
  }, [visibleEdges, data.nodes, query, filterRelation, minStrength, communityFilter]);

  const visibleNodes = useMemo(() => data.nodes.filter((n) => visibleNodeIds.has(n.id)), [data.nodes, visibleNodeIds]);

  // Search-highlighted ids
  const queryHitIds = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.trim().toLowerCase();
    return new Set(data.nodes.filter((n) => n.fullName.toLowerCase().includes(q) || n.company?.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id));
  }, [data.nodes, query]);

  // Scale radius by degree (hubs larger, bridges get halo)
  const radiusOf = useCallback((n: VizNode) => {
    const maxD = Math.max(1, ...data.nodes.map((x) => x.degree));
    return 7 + (n.degree / maxD) * 12;
  }, [data.nodes]);

  // Positions simulation
  const posRef = useRef<Map<string, Pos>>(new Map());

  // Resize observer for container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.max(420, Math.round(r.width));
      // Keep aspect roughly 16:9 but cap height
      const h = Math.min(640, Math.max(360, Math.round(w * 0.58)));
      setDims({ w, h });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Seed positions
  useEffect(() => {
    const m = new Map<string, Pos>();
    const cx = dims.w / 2, cy = dims.h / 2;
    const rng = (seed: string) => {
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      return h;
    };
    for (const n of data.nodes) {
      const h = rng(n.id);
      const ang = (h % 360) * (Math.PI / 180) + (rng(n.fullName) % 100) * 0.01;
      const rad = 60 + (h % 180);
      m.set(n.id, {
        x: cx + Math.cos(ang) * rad * (0.5 + Math.random() * 0.5),
        y: cy + Math.sin(ang) * rad * (0.5 + Math.random() * 0.5),
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
      });
    }
    posRef.current = m;
    setTick((t) => t + 1);
  }, [data.nodes, dims.w, dims.h]);

  // Physics loop
  useEffect(() => {
    if (paused || data.nodes.length === 0) return;
    let raf = 0;
    const alphaDecay = 0.02;
    let alpha = 1;

    const step = () => {
      if (alpha < 0.01) alpha = 0.01;
      const pos = posRef.current;
      if (pos.size === 0) { raf = requestAnimationFrame(step); return; }

      const visible = new Set(visibleNodes.map((n) => n.id));
      const w = dims.w, h = dims.h, cx = w / 2, cy = h / 2;

      // If very few nodes, keep centered
      const nodesArr = visibleNodes.map((n) => ({ n, p: pos.get(n.id)! })).filter((x) => !!x.p);

      // Repulsion: many-body, O(n^2) but bounded to 400 nodes
      for (let i = 0; i < nodesArr.length; i++) {
        for (let j = i + 1; j < nodesArr.length; j++) {
          const a = nodesArr[i]!, b = nodesArr[j]!;
          if (!pos.has(a.n.id) || !pos.has(b.n.id)) continue;
          if (draggingNode === a.n.id || draggingNode === b.n.id) continue;
          const ap = pos.get(a.n.id)!, bp = pos.get(b.n.id)!;
          const dx = ap.x - bp.x;
          const dy = ap.y - bp.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 0.1) dist = 0.1;
          if (dist > 260) continue;
          const repulse = (18000 * alpha) / (dist * dist);
          // Heavier hubs repel more
          const wA = 1 + (a.n.degree / 10);
          const wB = 1 + (b.n.degree / 10);
          const fx = (dx / dist) * repulse;
          const fy = (dy / dist) * repulse;
          ap.vx += fx * wB * 0.5;
          ap.vy += fy * wB * 0.5;
          bp.vx -= fx * wA * 0.5;
          bp.vy -= fy * wA * 0.5;
          // Collision spare push if too close
          if (dist < 22) {
            const push = (22 - dist) * 0.35;
            ap.vx += (dx / dist) * push;
            ap.vy += (dy / dist) * push;
            bp.vx -= (dx / dist) * push;
            bp.vy -= (dy / dist) * push;
          }
        }
      }

      // Links
      for (const e of visibleEdges) {
        const ap = pos.get(e.source), bp = pos.get(e.target);
        if (!ap || !bp) continue;
        if (draggingNode === e.source || draggingNode === e.target) continue;
        if (!visible.has(e.source) || !visible.has(e.target)) continue;
        const dx = ap.x - bp.x;
        const dy = ap.y - bp.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.1) dist = 0.1;
        const desired = 72 + (1 - Math.max(0, Math.min(1, e.strength))) * 90;
        const err = dist - desired;
        // stronger ties pull harder
        const k = 0.055 * (0.6 + e.strength * 0.9) * alpha;
        const fx = (dx / dist) * err * k;
        const fy = (dy / dist) * err * k;
        ap.vx -= fx;
        ap.vy -= fy;
        bp.vx += fx;
        bp.vy += fy;
      }

      // Gravity to center + mild damping
      for (const { n, p } of nodesArr) {
        if (draggingNode === n.id) continue;
        p.vx += (cx - p.x) * 0.005 * alpha;
        p.vy += (cy - p.y) * 0.005 * alpha;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;
        // Keep inside viewport with soft bounce
        const r = radiusOf(n) + 4;
        if (p.x < r) { p.x = r; p.vx *= -0.4; }
        if (p.x > w - r) { p.x = w - r; p.vx *= -0.4; }
        if (p.y < r) { p.y = r; p.vy *= -0.4; }
        if (p.y > h - r) { p.y = h - r; p.vy *= -0.4; }
      }

      alpha = Math.max(0.02, alpha * (1 - alphaDecay));
      setTick((t) => t + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [visibleNodes, visibleEdges, dims.w, dims.h, paused, draggingNode, radiusOf]);

  // Pointer handlers for nodes
  const toSvgCoords = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left - transform.x) / transform.k;
    const y = (e.clientY - rect.top - transform.y) / transform.k;
    return { x, y };
  }, [transform]);

  const handleNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDraggingNode(id);
    setSelected(id);
    const { x, y } = toSvgCoords(e);
    const p = posRef.current.get(id);
    if (p) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; }
  }, [toSvgCoords]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (draggingNode) {
      const { x, y } = toSvgCoords(e);
      const p = posRef.current.get(draggingNode);
      if (p) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; setTick((t) => t + 1); }
      return;
    }
    if (panning?.active) {
      const dx = e.clientX - panning.sx;
      const dy = e.clientY - panning.sy;
      setTransform({ x: panning.ox + dx, y: panning.oy + dy, k: transform.k });
    }
  }, [draggingNode, panning, toSvgCoords, transform.k]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    setDraggingNode(null);
    setPanning(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }, []);

  const handleBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest('[data-node]')) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setPanning({ active: true, sx: e.clientX, sy: e.clientY, ox: transform.x, oy: transform.y });
  }, [transform.x, transform.y]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const newK = Math.min(4, Math.max(0.2, transform.k * factor));
    // Zoom toward cursor
    const wx = (mx - transform.x) / transform.k;
    const wy = (my - transform.y) / transform.k;
    const nx = mx - wx * newK;
    const ny = my - wy * newK;
    setTransform({ x: nx, y: ny, k: newK });
  }, [transform]);

  const resetView = useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), []);

  // Derive selected node details
  const selectedNode = selected ? idToNode.get(selected) ?? null : null;
  const selectedNeighbors = useMemo(() => {
    if (!selected) return [];
    return visibleEdges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const otherId = e.source === selected ? e.target : e.source;
        return { edge: e, other: idToNode.get(otherId) };
      })
      .filter((x) => !!x.other) as Array<{ edge: VizEdge; other: VizNode }>;
  }, [selected, visibleEdges, idToNode]);

  if (data.nodes.length === 0) {
    return (
      <div style={{ border: '1px dashed #e5e7eb', borderRadius: 12, padding: '1.25rem', background: '#f9fafb', color: '#6b7280' }}>
        <div style={{ fontWeight: 650, color: '#374151', marginBottom: 6 }}>No graph to visualize yet</div>
        <div style={{ fontSize: '0.92rem', lineHeight: 1.55 }}>
          The interactive network appears once you have confirmed edges. Import a LinkedIn CSV via{' '}
          <code>netpro import</code> or <Link href="/import" style={{ color: '#2563eb' }}>the import page</Link>, then confirm candidate links
          on <Link href="/edges" style={{ color: '#2563eb' }}>Edges</Link>. When edges exist the graph shows communities (Louvain), hubs (degree),
          and bridges (Brandes betweenness) from <code>packages/core</code> — the UI never reimplements them.
          {data.meta.degraded ? <span style={{ color: '#b45309' }}> {data.meta.degraded.reason}</span> : null}
          {serverUrl ? <span style={{ color: '#9ca3af' }}> · server: <code>{serverUrl}</code></span> : null}
        </div>
        {data.meta.pendingCandidates ? (
          <div style={{ marginTop: '0.7rem', fontSize: '0.88rem' }}>
            <Link href="/edges?status=pending" style={{ color: '#2563eb' }}>{data.meta.pendingCandidates} pending candidate{data.meta.pendingCandidates === 1 ? '' : 's'} to review →</Link>
          </div>
        ) : null}
      </div>
    );
  }

  // Legend sorting
  const relationOptions = Array.from(new Set(data.edges.map((e) => e.relation))).sort();

  // For SVG rendering, snapshot positions
  const snapshot = Array.from(posRef.current.entries());

  return (
    <div ref={containerRef} style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: 'white' }}>
      {/* Controls bar */}
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.7rem 0.85rem', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
          <input
            type="search"
            placeholder="Search name, company, or id…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            aria-label="Search nodes"
            style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.38rem 0.6rem', fontSize: '0.85rem', minWidth: 180, background: 'white', flex: '0 1 220px' }}
          />
          <select value={filterRelation} onChange={(e) => setFilterRelation(e.currentTarget.value)} aria-label="Filter relation" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.35rem 0.5rem', fontSize: '0.82rem', background: 'white' }}>
            <option value="">Any relation</option>
            {relationOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={communityFilter ?? ''} onChange={(e) => setCommunityFilter(e.target.value ? Number(e.target.value) : null)} aria-label="Filter community" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.35rem 0.5rem', fontSize: '0.82rem', background: 'white', maxWidth: 180 }}>
            <option value="">All communities</option>
            {communities.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.count}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: '#374151' }}>
            Strength ≥ {minStrength.toFixed(2)}
            <input type="range" min={0} max={1} step={0.1} value={minStrength} onChange={(e) => setMinStrength(Number(e.target.value))} style={{ width: 90 }} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: '#475569' }}>
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> labels
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: '#475569' }}>
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> pause
          </label>
          <button onClick={resetView} style={{ border: '1px solid #e5e7eb', background: 'white', borderRadius: 8, padding: '0.3rem 0.6rem', fontSize: '0.8rem', cursor: 'pointer' }}>Reset view</button>
          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{visibleNodes.length} of {data.nodes.length} · {visibleEdges.length} edges{data.meta.truncated ? ` · truncated` : ''}</span>
        </div>
      </div>

      {/* Legend strip */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.55rem 0.85rem', borderBottom: '1px solid #f3f4f6', background: 'white' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#6b7280', letterSpacing: '0.03em', textTransform: 'uppercase' }}>Communities · mod {data.meta.modularity}</span>
        {communities.slice(0, 8).map((c) => (
          <button
            key={c.id}
            onClick={() => setCommunityFilter((prev) => (prev === c.id ? null : c.id))}
            title={`${c.members.slice(0, 6).join(', ')}${c.members.length > 6 ? '…' : ''}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              border: `1px solid ${communityFilter === c.id ? communityColor(c.id) : '#e5e7eb'}`,
              background: communityFilter === c.id ? `${communityColor(c.id)}14` : 'white',
              color: '#374151',
              borderRadius: 999,
              padding: '0.22rem 0.55rem',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: communityColor(c.id), display: 'inline-block' }} />
            {c.label} <span style={{ color: '#6b7280' }}>{c.count}</span>
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#9ca3af' }}>
          Bridges <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'white', border: '2px solid #f59e0b', verticalAlign: 'middle', margin: '0 3px' }} /> have amber halo · hubs <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: '#111827', verticalAlign: 'middle', margin: '0 3px' }} /> are darker
        </span>
      </div>

      <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap' }}>
        {/* Canvas */}
        <div
          style={{ flex: '1 1 560px', minWidth: 420, position: 'relative', background: '#fcfdff', borderRight: '1px solid #f3f4f6' }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <svg
            ref={svgRef}
            width={dims.w}
            height={dims.h}
            viewBox={`0 0 ${dims.w} ${dims.h}`}
            role="img"
            aria-label={`Network graph: ${data.meta.shownNodes} people, ${data.meta.shownEdges} relationships, ${data.meta.communities} communities`}
            onWheel={handleWheel}
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ display: 'block', touchAction: 'none', cursor: panning?.active ? 'grabbing' : 'grab', background: 'radial-gradient(1200px 600px at 40% -10%, #eff6ff 0%, transparent 55%), radial-gradient(900px 500px at 90% 110%, #f0fdf4 0%, transparent 55%)' }}
          >
            {/* Zoomable group */}
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
              {/* Edges */}
              {visibleEdges.map((e) => {
                const a = posRef.current.get(e.source);
                const b = posRef.current.get(e.target);
                if (!a || !b) return null;
                const isHoveredEdge = hovered === e.source || hovered === e.target;
                const isSelectedEdge = selected === e.source || selected === e.target;
                const hitQ = queryHitIds && (queryHitIds.has(e.source) || queryHitIds.has(e.target));
                const w = 0.9 + e.strength * 2.6;
                const opacity = 0.18 + e.confidence * 0.32 + e.strength * 0.18 + (isHoveredEdge || isSelectedEdge ? 0.28 : 0) + (hitQ ? 0.15 : 0);
                const color = isSelectedEdge ? '#111827' : isHoveredEdge ? '#374151' : '#94a3b8';
                return (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={color}
                    strokeWidth={w}
                    strokeOpacity={Math.min(1, opacity)}
                    strokeLinecap="round"
                  >
                    <title>{`${idToNode.get(e.source)?.fullName ?? e.source} —[${e.relation} ${e.strength.toFixed(2)}]→ ${idToNode.get(e.target)?.fullName ?? e.target}`}</title>
                  </line>
                );
              })}
              {/* Nodes */}
              {visibleNodes.map((n) => {
                const p = posRef.current.get(n.id);
                if (!p) return null;
                const r = radiusOf(n);
                const isHub = hubSet.has(n.id);
                const isBridge = bridgeSet.has(n.id);
                const isSel = selected === n.id;
                const isHover = hovered === n.id;
                const isHit = queryHitIds?.has(n.id) ?? false;
                const fill = communityColor(n.communityId);
                const stroke = isSel ? '#111827' : isBridge ? '#f59e0b' : isHub ? '#111827' : 'white';
                const strokeW = isSel ? 2.5 : isBridge ? 2.2 : isHub ? 1.6 : 1.2;
                const opacity = queryHitIds ? (isHit ? 1 : 0.22) : 1;
                return (
                  <g
                    key={n.id}
                    data-node={n.id}
                    opacity={opacity}
                    onPointerDown={(ev) => handleNodePointerDown(ev, n.id)}
                    onPointerEnter={() => setHovered(n.id)}
                    onPointerLeave={() => setHovered((cur) => (cur === n.id ? null : cur))}
                    onClick={() => setSelected(n.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    {isBridge ? <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke="#fef3c7" strokeWidth={7} opacity={0.9} /> : null}
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={strokeW}
                      opacity={0.98}
                    >
                      <title>{`${n.fullName}${n.company ? ` — ${n.company}` : ''} · ${n.communityLabel} · deg ${n.degree}${n.betweenness !== null ? ` · btw ${n.betweenness}` : ''} · score ${scoreLabel(n.relationshipScore)}`}</title>
                    </circle>
                    {/* Hub dot */}
                    {isHub ? <circle cx={p.x} cy={p.y} r={2.2} fill="white" opacity={0.95} /> : null}
                    {/* Hover/selected ring */}
                    {isHover || isSel ? <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke={fill} strokeWidth={1.2} strokeOpacity={0.45} strokeDasharray={isSel ? undefined : '4 4'} /> : null}
                    {showLabels ? (
                      <text
                        x={p.x}
                        y={p.y + r + 13}
                        textAnchor="middle"
                        fontSize={Math.max(9, Math.min(12, r * 0.7 + 7))}
                        fill={isSel ? '#111827' : isHit ? '#111827' : '#334155'}
                        fontWeight={isHub || isSel ? 650 : isHit ? 600 : 500}
                        paintOrder="stroke"
                        stroke="white"
                        strokeWidth={3}
                        strokeLinejoin="round"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {n.fullName.length > 22 ? `${n.fullName.slice(0, 21)}…` : n.fullName}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
            {/* Static overlay: transform indicator */}
            <text x={10} y={dims.h - 10} fontSize={10} fill="#9ca3af" style={{ userSelect: 'none', pointerEvents: 'none' }}>
              Drag background to pan · scroll to zoom ({Math.round(transform.k * 100)}%) · drag nodes to pin · click a node for details
            </text>
          </svg>

          {/* Truncated banner */}
          {data.meta.truncated ? (
            <div style={{ position: 'absolute', top: 8, left: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 8, padding: '0.3rem 0.6rem', fontSize: '0.8rem', maxWidth: '70%' }}>
              {data.meta.truncatedReason}
            </div>
          ) : null}
          {data.meta.degraded ? (
            <div style={{ position: 'absolute', top: data.meta.truncated ? 44 : 8, left: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 8, padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
              {data.meta.degraded.reason}
            </div>
          ) : null}
        </div>

        {/* Details / stats pane */}
        <div style={{ flex: '0 1 300px', minWidth: 280, padding: '0.85rem 0.9rem', background: 'white', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
              At a glance
              <span style={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 500 }}>{data.meta.shownNodes} nodes · {data.meta.shownEdges} edges</span>
            </div>
            <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4, lineHeight: 1.55 }}>
              {data.meta.communities} communities (Louvain, mod {data.meta.modularity}) · drag any node — physics respects relationship strength: strong ties
              pull closer, weak ties drift apart.
            </div>
          </div>

          {/* Selected node */}
          {selectedNode ? (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '0.75rem 0.85rem', background: '#f8fafc' }}>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: communityColor(selectedNode.communityId), display: 'inline-block', border: '1px solid #e5e7eb' }} />
                <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#111827' }}>{selectedNode.fullName}</div>
                <button onClick={() => setSelected(null)} style={{ marginLeft: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: 'white', padding: '0.2rem 0.45rem', fontSize: '0.75rem', cursor: 'pointer' }}>Clear</button>
              </div>
              <div style={{ fontSize: '0.82rem', color: '#6b7280', marginTop: 2 }}>
                {selectedNode.company ?? '—'} {selectedNode.role ? `· ${selectedNode.role}` : ''} · in <strong style={{ color: '#374151' }}>{selectedNode.communityLabel}</strong>
              </div>
              <div style={{ fontSize: '0.82rem', color: '#475569', marginTop: 6, display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                <span>degree <strong>{selectedNode.degree}</strong></span>
                {selectedNode.betweenness !== null ? <span>betweenness <strong>{selectedNode.betweenness}</strong> {bridgeSet.has(selectedNode.id) ? <span style={{ color: '#f59e0b' }}>· bridge</span> : null}</span> : null}
                <span>score {scoreLabel(selectedNode.relationshipScore)}</span>
              </div>
              <div style={{ marginTop: '0.65rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Link href={`/contacts/${selectedNode.id}`} style={{ fontSize: '0.82rem', color: '#2563eb', border: '1px solid #dbeafe', background: '#eff6ff', borderRadius: 8, padding: '0.25rem 0.55rem', textDecoration: 'none' }}>Open contact →</Link>
                <Link href={`/graph/${selectedNode.id}`} style={{ fontSize: '0.82rem', color: '#374151', border: '1px solid #e5e7eb', background: 'white', borderRadius: 8, padding: '0.25rem 0.55rem', textDecoration: 'none' }}>Position →</Link>
                <Link href={`/network?target=${encodeURIComponent(selectedNode.id)}`} style={{ fontSize: '0.82rem', color: '#6b7280' }}>Find path to →</Link>
              </div>
              {selectedNeighbors.length > 0 ? (
                <div style={{ marginTop: '0.7rem' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#6b7280', letterSpacing: '0.03em', textTransform: 'uppercase' }}>Neighbors · relationships</div>
                  <ul style={{ margin: '0.35rem 0 0', paddingLeft: 0, listStyle: 'none', display: 'grid', gap: '0.3rem' }}>
                    {selectedNeighbors.slice(0, 12).map(({ edge, other }) => (
                      <li key={edge.id} style={{ display: 'flex', gap: '0.45rem', alignItems: 'baseline', fontSize: '0.84rem', color: '#374151' }}>
                        <span style={{ width: other.degree > 6 ? 7 : 5, height: other.degree > 6 ? 7 : 5, borderRadius: 999, background: communityColor(other.communityId), display: 'inline-block', flexShrink: 0, marginTop: 4 }} />
                        <Link href={`/contacts/${other.id}`} style={{ color: '#2563eb' }}>{other.fullName}</Link>
                        <span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>· {edge.relation} · {edge.strength.toFixed(2)} {edge.bidirectional ? '' : '· one-way'}</span>
                        <button onClick={() => setSelected(other.id)} style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280', border: '1px solid #e5e7eb', background: 'white', borderRadius: 999, padding: '0.1rem 0.4rem', cursor: 'pointer' }}>Focus</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: '#9ca3af' }}>No relationships visible under current filters.</div>}
            </div>
          ) : (
            <div style={{ border: '1px dashed #e5e7eb', borderRadius: 10, padding: '0.75rem 0.85rem', background: '#fcfdff', color: '#6b7280', fontSize: '0.86rem' }}>
              Click any node to inspect: community, strength of each tie, and one-click links to the contact and pathfinder. Hover to
              highlight its edges.
            </div>
          )}

          {/* Hubs & bridges */}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '0.75rem 0.85rem', background: 'white' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#6b7280' }}>Most connected · hubs (degree)</div>
            <ol style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', fontSize: '0.84rem', color: '#374151' }}>
              {hubs.slice(0, 5).map((h) => (
                <li key={h.id} style={{ marginBottom: 2 }}>
                  <button
                    onClick={() => setSelected(h.id)}
                    style={{ color: selected === h.id ? '#111827' : '#2563eb', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline', textDecorationColor: '#dbeafe' }}
                  >
                    {h.fullName}
                  </button>{' '}
                  <span style={{ color: '#6b7280' }}>— {h.degree} edges{bridgeSet.has(h.id) ? ' · bridge' : ''}</span>
                </li>
              ))}
            </ol>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#6b7280', marginTop: '0.75rem' }}>Important intermediaries · bridges (betweenness)</div>
            {bridges.length > 0 ? (
              <ol style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem', fontSize: '0.84rem', color: '#374151' }}>
                {bridges.slice(0, 5).map((b) => (
                  <li key={b.id} style={{ marginBottom: 2 }}>
                    <button onClick={() => setSelected(b.id)} style={{ color: selected === b.id ? '#111827' : '#2563eb', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline', textDecorationColor: '#fef3c7' }}>{b.fullName}</button>{' '}
                    <span style={{ color: '#6b7280' }}>· {b.betweenness}</span>
                  </li>
                ))}
              </ol>
            ) : <div style={{ fontSize: '0.82rem', color: '#9ca3af', marginTop: 4 }}>Betweenness skipped for large graphs (see note under Most connected).</div>}
          </div>

          <div style={{ fontSize: '0.78rem', color: '#6b7280', lineHeight: 1.5 }}>
            Pathfinding stays server-driven (<code>GET /api/graph/path</code>). Use{' '}
            <Link href="/graph" style={{ color: '#2563eb' }}>
              Pathfinder
            </Link>{' '}
            or the warm-intro list below for ranked chains — the UI never reimplements the ranking.
          </div>
        </div>
      </div>
    </div>
  );
}
