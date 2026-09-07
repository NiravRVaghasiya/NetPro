'use client';

// apps/web/app/(app)/skills/panels.tsx
//
// The one interactive piece of /skills: the "derive skills" button. It posts
// to /api/skills/extract (owner-only), shows the summary, and refreshes the
// server-rendered analysis. The AI pass is a separate, explicit checkbox —
// heuristic extraction is the default and needs no key; the key itself lives
// in the server environment and never reaches this component.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Summary {
  scanned: number;
  updated: number;
  unchanged: number;
  withSkills: number;
  mode: 'heuristic' | 'ai';
  dryRun: boolean;
  aiErrors: Array<{ contactId: string; error: string }>;
}

export function ExtractPanel({ neverExtracted, total }: { neverExtracted: number; total: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  async function extract(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch('/api/skills/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: useAi ? 'ai' : 'heuristic', dryRun }),
      });
      const data = (await res.json().catch(() => null)) as (Summary & { error?: string }) | null;
      if (!res.ok || !data) {
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSummary(data);
      if (!dryRun) router.refresh();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Derive skills"
      style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem', margin: '1rem 0' }}
    >
      <p style={{ margin: '0 0 0.5rem' }}>
        {total === 0
          ? 'No contacts yet — import some first.'
          : neverExtracted > 0
            ? `${neverExtracted} of ${total} contacts have never had skills derived.`
            : `All ${total} contacts have a stored skills verdict.`}{' '}
        <span style={{ color: '#6b7280' }}>
          Extraction reads headline, role, notes, tags and custom fields against NetPro&apos;s taxonomy; it
          never edits those fields, and re-running only updates what changed.
        </span>
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" disabled={busy || total === 0} onClick={() => extract(false)}>
          {busy ? 'Working…' : 'Derive skills for all contacts'}
        </button>
        <button type="button" disabled={busy || total === 0} onClick={() => extract(true)}>
          Preview changes
        </button>
        <label style={{ fontSize: '0.85rem', color: '#374151' }}>
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} disabled={busy} />{' '}
          also run the AI pass (uses the server&apos;s configured key; picks only taxonomy skills)
        </label>
      </div>
      {error ? (
        <p role="alert" style={{ color: '#b91c1c', marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
      {summary ? (
        <p role="status" style={{ marginBottom: 0 }}>
          {summary.dryRun ? 'Preview: ' : ''}
          scanned {summary.scanned} · {summary.dryRun ? 'would update' : 'updated'} {summary.updated} · unchanged{' '}
          {summary.unchanged} · with skills {summary.withSkills} ({summary.mode})
          {summary.aiErrors.length > 0
            ? ` · AI pass failed for ${summary.aiErrors.length} — heuristics still applied: ${summary.aiErrors[0]!.error}`
            : ''}
        </p>
      ) : null}
    </section>
  );
}
