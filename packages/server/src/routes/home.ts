// packages/server/src/routes/home.ts
//
// GET / — the built-in local console page.
//
// The Phase 2 plan prints `Web UI: http://127.0.0.1:3777` when the server
// starts, so that URL must show something useful even before the full
// Observatory UI (Phase 9+) exists: server identity, database location, and
// live health, fetched client-side from /api/health. One dependency-free HTML
// string — no framework, no external assets, no build step.

import type { ServerResponse } from 'node:http';
import { sendText } from '../middleware/json';

export const SERVER_VERSION = '3.0.0';

export type HomeInfo = {
  dialect: string;
  /** Display-safe database location (SQLite path or redacted Postgres URL). */
  database: string;
};

export function renderHomeHtml(info: HomeInfo): string {
  const dialectLabel = info.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NetPro — local server</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  main { width: min(560px, calc(100vw - 3rem)); }
  h1 { margin: 0 0 .25rem; font-size: 1.75rem; letter-spacing: .02em; }
  h1 span { color: #58a6ff; }
  p.sub { margin: 0 0 1.5rem; color: #8b949e; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 1.25rem 1.5rem; margin-bottom: 1rem;
  }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: .35rem 0; }
  .row dt { color: #8b949e; }
  .row dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
  #health { font-weight: 600; }
  #health.ok { color: #3fb950; }
  #health.bad { color: #f85149; }
  code a { color: #58a6ff; text-decoration: none; }
  code a:hover { text-decoration: underline; }
  footer { color: #8b949e; font-size: .85rem; }
</style>
</head>
<body>
<main>
  <h1>Net<span>Pro</span></h1>
  <p class="sub">Local server v${SERVER_VERSION} — your professional network, on this machine.</p>
  <div class="card">
    <dl>
      <div class="row"><dt>Status</dt><dd id="health">checking…</dd></div>
      <div class="row"><dt>Database</dt><dd>${escapeHtml(dialectLabel)} — ${escapeHtml(info.database)}</dd></div>
      <div class="row"><dt>API</dt><dd><code><a href="/api/health">/api/health</a></code></dd></div>
    </dl>
  </div>
  <footer>
    The full Observatory UI lives in the NetPro web app and connects to this
    server. CLI: <code>netpro --help</code>.
  </footer>
</main>
<script>
  fetch('/api/health').then(r => r.json()).then(h => {
    const el = document.getElementById('health');
    el.textContent = h.status + ' · ' + h.dialect + ' · ' + h.latencyMs + ' ms';
    el.className = h.status === 'healthy' ? 'ok' : 'bad';
  }).catch(() => {
    const el = document.getElementById('health');
    el.textContent = 'unreachable';
    el.className = 'bad';
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function handleHome(res: ServerResponse, info: HomeInfo): void {
  sendText(res, 200, renderHomeHtml(info), 'text/html; charset=utf-8');
}
