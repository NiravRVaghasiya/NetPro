"use client";

import { useState } from 'react';

interface ActivityRow {
  id: string;
  workspaceId: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  createdAt: string;
}

interface Page {
  rows: ActivityRow[];
  total: number;
  limit: number;
  offset: number;
}

interface Member {
  userId: string;
  role: string;
  user: { id: string; name: string | null; email: string } | null;
}

interface Props {
  initialPage: Page;
  initialFilters: {
    action: string;
    entityType: string;
    userId: string;
    from: string;
    to: string;
  };
  members: Member[];
}

export default function ActivityClient({ initialPage, initialFilters, members }: Props) {
  const [page, setPage] = useState<Page>(initialPage);
  const [filters, setFilters] = useState(initialFilters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage(newOffset = 0, overrideFilters = filters) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(page.limit));
      params.set('offset', String(newOffset));
      if (overrideFilters.action) params.set('action', overrideFilters.action);
      if (overrideFilters.entityType) params.set('entityType', overrideFilters.entityType);
      if (overrideFilters.userId) params.set('userId', overrideFilters.userId);
      if (overrideFilters.from) params.set('from', overrideFilters.from);
      if (overrideFilters.to) params.set('to', overrideFilters.to);
      const res = await fetch(`/api/activity?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load');
      } else {
        setPage(data);
        // update URL without reload
        const url = new URL(window.location.href);
        url.searchParams.set('action', overrideFilters.action);
        url.searchParams.set('entityType', overrideFilters.entityType);
        url.searchParams.set('userId', overrideFilters.userId);
        url.searchParams.set('from', overrideFilters.from);
        url.searchParams.set('to', overrideFilters.to);
        url.searchParams.set('offset', String(newOffset));
        window.history.replaceState({}, '', url.toString());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function onFilterChange(field: keyof typeof filters, value: string) {
    const next = { ...filters, [field]: value };
    setFilters(next);
  }

  function applyFilters() {
    fetchPage(0, filters);
  }

  function clearFilters() {
    const empty = { action: '', entityType: '', userId: '', from: '', to: '' };
    setFilters(empty);
    fetchPage(0, empty);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-end p-3 border rounded bg-slate-50">
        <div>
          <label className="text-xs text-slate-600">Action prefix</label>
          <input
            value={filters.action}
            onChange={(e) => onFilterChange('action', e.target.value)}
            placeholder="e.g. followup."
            className="block border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-600">Entity type</label>
          <input
            value={filters.entityType}
            onChange={(e) => onFilterChange('entityType', e.target.value)}
            placeholder="contact, campaign..."
            className="block border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-600">Member</label>
          <select
            value={filters.userId}
            onChange={(e) => onFilterChange('userId', e.target.value)}
            className="block border rounded px-2 py-1 text-sm"
          >
            <option value="">any member</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user?.name || m.user?.email || m.userId.slice(0, 8)} ({m.role})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-600">From</label>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => onFilterChange('from', e.target.value)}
            className="block border rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-600">To</label>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => onFilterChange('to', e.target.value)}
            className="block border rounded px-2 py-1 text-sm"
          />
        </div>
        <button
          onClick={applyFilters}
          disabled={loading}
          className="px-3 py-1 bg-black text-white rounded text-sm disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Filter'}
        </button>
        <button onClick={clearFilters} className="px-3 py-1 border rounded text-sm">
          Clear
        </button>
      </div>

      {error && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}

      <div className="text-sm text-slate-600">
        Showing {page.rows.length} of {page.total} · offset {page.offset}
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-slate-50">
            <th className="text-left p-2">When</th>
            <th className="text-left p-2">Action</th>
            <th className="text-left p-2">Entity</th>
            <th className="text-left p-2">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((r) => (
            <tr key={r.id} className="border-b">
              <td className="p-2 whitespace-nowrap text-xs">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="p-2 font-mono text-xs">{r.action}</td>
              <td className="p-2 text-xs">
                {r.entityType ? `${r.entityType}:${r.entityId?.slice(0, 8) ?? ''}` : '—'}
              </td>
              <td className="p-2 text-xs max-w-[300px] truncate">
                {r.metadata ? JSON.stringify(r.metadata).slice(0, 200) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex gap-2">
        <button
          disabled={page.offset === 0 || loading}
          onClick={() => fetchPage(Math.max(0, page.offset - page.limit))}
          className="px-3 py-1 border rounded text-sm disabled:opacity-30"
        >
          Previous
        </button>
        <button
          disabled={page.offset + page.limit >= page.total || loading}
          onClick={() => fetchPage(page.offset + page.limit)}
          className="px-3 py-1 border rounded text-sm disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  );
}
