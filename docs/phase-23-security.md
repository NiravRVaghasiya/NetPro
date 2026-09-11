# Phase 23 — Security hardening

**Generated:** 2026-09-11
**Follows:** [Phase 22](phase-22-migration.md)

## Objective

Local-first does not mean security-free: the install directory holds the
whole professional network, and `netpro serve` can be deliberately exposed.
This phase makes the default posture safe and every exposure explicit:

```text
safe by default                          explicit to expose
────────────────                          ──────────────────
127.0.0.1 bind, loopback trust     →      --host 0.0.0.0 + access token
0700 install dir, 0600 secrets     →      (nothing to do — stays owner-only)
loopback-only CORS                 →      NETPRO_ALLOWED_ORIGINS
600 req/min per IP                 →      NETPRO_RATE_LIMIT_* tuning
HSTS off (no TLS to assert)        →      reverse proxy + NETPRO_HSTS=true
webhooks: no private targets       →      NETPRO_WEBHOOKS_ALLOW_PRIVATE=1
plugins: disabled until reviewed   →      enable (warns: in-process)
```

The rule throughout: the safe behaviour is what happens when the operator
configures nothing, and every relaxation names itself — in a startup line, a
CLI warning, or an error message — at the moment it takes effect.

---

## Files and credentials

| Asset | Protection |
|-------|------------|
| `~/.netpro/`, `logs/`, `keys/` | `ensureNetProHome` creates **and re-tightens** to 0700 |
| `netpro.db` (+ `-wal`/`-shm`) | `createDb` chmods to 0600 on every open |
| Access token (`keys/access-token`) | 0600 since Phase 5; unchanged |
| Backups (`backups/*.db`, safety copies) | 0600 since Phase 22; unchanged |
| `netpro export --output` | 0600 on create **and** on overwrite of a looser file |
| `DATABASE_URL` | never printed: `netpro status`, `/api/settings`, and logs use the redacted display |
| `/api/settings` `configFile` echo | `[database] url` is redacted (host kept, credential dropped) |

Re-tightening matters: installs created before this phase get the safe modes
the next time they are touched, with no migration step and no user action.

## The standalone server

**Headers.** Every response carries `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`, including probes,
errors, and 404s. `Strict-Transport-Security` is opt-in (`NETPRO_HSTS=true`)
because asserting it over plain HTTP would be a lie — it belongs behind a
TLS-terminating proxy. The console pages (`/`, the locked page) add a strict
self-only Content-Security-Policy; they are static inline HTML with a
same-origin EventSource, so `default-src 'none'` plus inline is everything
they need.

**CORS.** Grants require *both* authentication (as before) *and* an allowed
origin. With no allow-list, only loopback origins (`localhost`, `127/8`,
`::1`, IPv4-mapped loopback) qualify — the local UI keeps working while a
random internet page cannot read API responses. `NETPRO_ALLOWED_ORIGINS`
(winning) or the config-file `allowed_origins` names remote UIs with exact
matches: no wildcards, no suffix tricks, and naming a list replaces the
loopback default. Unknown `[server]` keys are now rejected, so a typo like
`allow_origin` fails loudly instead of silently leaving the default.

**Rate limiting.** 600 requests/minute per peer IP (fixed window, in-process —
a local server needs no Redis counter), enforced before auth so token-guessing
collapses into `429` + `Retry-After`. Readiness probes and CORS preflights are
exempt: a monitor must never read a limit as an outage. Tuning via
`NETPRO_RATE_LIMIT_MAX` / `_WINDOW_MS`; `NETPRO_RATE_LIMIT_ENABLED=0`
disables. Garbage values fall back to the safe default, never to unlimited.

**Startup honesty.** A non-loopback bind prints the exposure policy on every
start — browser origins, rate budget, HSTS — plus the reverse-proxy reminder
when TLS is absent. See [deployment.md](deployment.md#remote-exposure-checklist)
for the ordered checklist: bind → authenticate → TLS → origins → rate limit →
database → files → webhooks/plugins.

## Webhooks

Documented in [webhooks.md](webhooks.md#security); the shape of the change:

- Private-network targets are **refused** at create/update time and re-checked
  on **every delivery attempt** — a pre-hardening row cannot bypass the guard.
- Redirects are followed manually (max 3 hops) with each hop re-validated, so
  `302 → http://169.254.169.254/` fails instead of leaking the payload.
- The escape hatch is one variable: `NETPRO_WEBHOOKS_ALLOW_PRIVATE=1`, named
  in the error and the CLI confirmation.
- Timeouts (10s/hop), payload caps (256KB), attempt caps (8, backoff to
  dead-letter), and truncated logs predate this phase and are unchanged.

## Plugins

Plugins load via dynamic `import()` into the NetPro process: no sandbox, full
database access. That was already true; what this phase adds is saying it out
loud — `plugin enable` prints the in-process warning on every success, next to
the existing install-disabled-by-default gate and the `--i-have-reviewed-permissions`
review requirement.

## What was already there

A hardening phase should also record what it inspected and left alone:

- Postgres TLS (`sslmode` mapping, `NETPRO_DB_SSL_CA`) — see
  [deployment.md](deployment.md#database-tls).
- Auth modes and the remote-bind token minting — see
  [phase-5-authentication.md](phase-5-authentication.md).
- Request body caps (16 KiB default, 5 MiB imports → 413), JSON content-type
  enforcement, and the 5MB CSV import cap.
- Terse public probes: anonymous `/api/health` omits driver detail; `?verbose`
  needs the owner session.
- HMAC-signed webhooks with timing-safe verification and 5-minute skew
  tolerance; AES-256-GCM vault with a 32-character master gate.
- `GET /api/settings` authenticates before revealing anything (redaction is
  defense in depth, not the boundary).

## Exit criteria

| Criterion | Status |
|-----------|--------|
| Local server binds 127.0.0.1 by default | ✅ pre-existing, pinned by tests |
| db / credentials / keys / backups / exports / logs owner-only | ✅ 0700/0600 + re-tightening |
| Remote mode: explicit bind, auth, TLS guidance, origins, sessions, rate limit | ✅ checklist + startup summary + tests |
| Plugin sandbox posture stated (in-process warning) | ✅ enable-time warning |
| Webhooks: URL/auth/retries/SSRF/timeouts/payload validated | ✅ enforced + documented |
