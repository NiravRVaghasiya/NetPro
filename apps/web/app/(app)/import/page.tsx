'use client';

import { useState } from 'react';

interface ImportSummary {
  imported: number;
  merged: number;
  errors: Array<{ row: number; reason: string }>;
}

export default function ImportPage() {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleFile(file: File) {
    setLoading(true);
    setError(null);
    setSummary(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/import', { method: 'POST', body: formData });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? 'Import failed');
      }
      const data: ImportSummary = await response.json();
      setSummary(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Import</h1>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        style={{ border: '2px dashed #ccc', padding: '2rem', textAlign: 'center' }}
      >
        <p>Drag a LinkedIn connections CSV here, or:</p>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>
      {loading && <p>Importing…</p>}
      {error && <p role="alert">{error}</p>}
      {summary && (
        <p>
          ✓ Imported {summary.imported} contacts ({summary.merged} merged)
          {summary.errors.length > 0 && ` — ${summary.errors.length} row(s) skipped`}
        </p>
      )}
    </div>
  );
}
