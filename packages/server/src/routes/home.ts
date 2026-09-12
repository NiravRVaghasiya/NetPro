// packages/server/src/routes/home.ts
//
// GET / — the built-in local console page.
//
// `netpro serve` prints this address as "API + built-in console", so it must
// show something useful to a human who opens it: server identity, database
// location, and live health, fetched client-side from /api/health. One
// dependency-free HTML string — no framework, no external assets, no build
// step. The full Observatory UI is the separate apps/web client (see the
// footer), which is why the banner no longer advertises this port as the
// "Web UI".

import type { ServerResponse } from 'node:http';
import { sendText } from '../middleware/json';
import { applyConsoleCsp } from '../middleware/security';
import { SERVER_VERSION } from '../version';

// Re-exported because the console page and the package index both take it from
// here; the single literal lives in `../version` (see version.test.ts).
export { SERVER_VERSION };

export type HomeInfo = {
  dialect: string;
  /** Display-safe database location (SQLite path or redacted Postgres URL). */
  database: string;
  /** Local installation identity (Phase 5); absent on an un-initialized install. */
  installation?: { id: string; createdAt: string; owner?: string } | null;
  /** Authentication mode in force (Phase 5). */
  authMode?: string;
};

export function renderHomeHtml(info: HomeInfo): string {
  const dialectLabel = info.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL';
  // Local identity replaces the user profile the OAuth model used to show.
  const identityRow = info.installation
    ? `      <div class="row"><dt>Installation</dt><dd>${escapeHtml(info.installation.id)}${
        info.installation.owner ? ` · ${escapeHtml(info.installation.owner)}` : ''
      }</dd></div>\n`
    : `      <div class="row"><dt>Installation</dt><dd>not initialized — run <code>netpro init</code></dd></div>\n`;
  const authRow = info.authMode
    ? `      <div class="row"><dt>Auth</dt><dd>${escapeHtml(authModeLabel(info.authMode))}</dd></div>\n`
    : '';
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
      ${identityRow}
      ${authRow}
      <div class="row"><dt>API</dt><dd><code><a href="/api/health">/api/health</a></code> · <code><a href="/api/identity">/api/identity</a></code></dd></div>
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

/** One-line description of the auth mode for humans. */
function authModeLabel(mode: string): string {
  if (mode === 'open') return 'open — no authentication';
  if (mode === 'token') return 'token required for every request';
  return 'local — loopback trusted';
}

export type LockedInfo = {
  authMode: string;
  reason?: string;
};

/**
 * What a non-local caller sees at `/`.
 *
 * The console page names the database location, so it is local-only. This page
 * still tells the visitor the server is up and exactly how to authenticate,
 * which beats a bare 401 for anyone who exposed the port on purpose.
 */
export function renderLockedHtml(info: LockedInfo): string {
  const detail =
    info.reason === 'invalid-credentials'
      ? 'The access token in the request is not the one this installation issued.'
      : 'This page is only served to the machine NetPro runs on.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NetPro — local access only</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  main { width: min(560px, calc(100vw - 3rem)); }
  h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
  h1 span { color: #58a6ff; }
  p { color: #8b949e; }
  code { color: #e6edf3; background: #161b22; padding: .1rem .3rem; border-radius: 4px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1.25rem 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>Net<span>Pro</span> — local access only</h1>
  <div class="card">
    <p>${escapeHtml(detail)}</p>
    <p>Auth mode: <code>${escapeHtml(info.authMode)}</code></p>
    <p>
      NetPro is running. This installation trusts requests from its own machine;
      from anywhere else it needs the local access token
      (<code>Authorization: Bearer &lt;token&gt;</code> — see <code>netpro token</code>).
    </p>
    <p><a href="/api/health" style="color:#58a6ff">/api/health</a> is public.</p>
  </div>
</main>
</body>
</html>`;
}

export function handleLocked(res: ServerResponse, info: LockedInfo): void {
  applyConsoleCsp(res); // Phase 23 — setHeader merges with sendText's writeHead.
  sendText(res, 401, renderLockedHtml(info), 'text/html; charset=utf-8');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function handleHome(res: ServerResponse, info: HomeInfo): void {
  applyConsoleCsp(res); // Phase 23 — setHeader merges with sendText's writeHead.
  sendText(res, 200, renderHomeHtml(info), 'text/html; charset=utf-8');
}
