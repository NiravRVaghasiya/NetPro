# Changelog

All notable changes to NetPro are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
the product milestones in the [project blueprint](NetPro%20%E2%80%94%20Blueprint.md)
(`vX.Y` milestones, published as `X.Y.0` npm/GitHub versions).

## [Unreleased] — v3.0 platform work

### Added — Phase 3 (complete): team collaboration — assignments, owner transfer, audit viewer

- Migration `0012_team_collaboration` (both dialects): `follow_ups.assigned_to` (nullable text user id; null = unassigned/anyone, no FK to avoid hard coupling to Auth.js users) plus three indexes `idx_followups_assigned_to`, `idx_followups_workspace_assigned`, `idx_followups_workspace_status_assigned_due` for the dashboard and filtered lists. Additive, idempotent, single-workspace single-member installs behave identically to v2.5 (all follow-ups unassigned, existing queries return same rows).
- Core CRM: `createFollowUp` now accepts `assignedTo`; `listFollowUps` gains filters `assignedTo`, `assignedToMe` (scoped to `scope.userId`), `unassigned`; `assignFollowUp` (pending-only, workspace-scoped, audit `followup.assigned`) and `unassignFollowUpsForUser` (pending-only, counts, audit `followup.unassigned_on_member_removal`). Contact timeline and interaction list now surface `createdByUser` author stamps; follow-up rows surface `assignedTo` and `createdByUser`.
- Workspaces service: `assertCanChangeRole` now enforces owner-only for `owner` role assignment and owner-only for changing another owner's role; `assertCanRemoveMember` unchanged but tested for break-glass and last-owner; new `removeMemberAndReassign` unassigns pending follow-ups of the removed user within the same workspace (cross-workspace isolation enforced) and writes `workspace.member.removed` audit entry with reassigned count. Owner transfer flow: owner can promote another member to owner, then demote self (requires second owner).
- Activity reader `listActivityLog` (new `packages/core/src/crm/activity-reader.ts`): paginated, workspace-scoped audit viewer with filters `actionPrefix`, `entityType`, `userId` (best-effort metadata LIKE + entityId match), date range `from`/`to`; newest first, limit 1–100. Unscoped calls resolve to bootstrap workspace (compat).
- Web: dashboard now shows two strips — Assigned to me (5) and Unassigned (5) — with links to filtered contacts; contacts list `?assignedToMe=1` / `?unassigned=1` filter nav and filtered summary; contact detail shows `assigned to` and `by` (author) for follow-ups and interactions; AddFollowUp panel supports assigning on creation; FollowUpActions supports Assign/Unassign with input. Settings → Team disables owner option unless currentRole=owner, removal confirm mentions unassign and alerts reassigned count. New admin-only Settings → Activity log page (`/settings/activity`) with filters (action prefix, entity type, member, date) and pagination, plus owner-only API `GET /api/activity` mirroring `listActivityLog` with same filters.
- CLI: `track` command extended — `list` now accepts `--assigned-to <userId>`, `--assigned-to-me` (current workspace user), `--unassigned`; `add` accepts `--assigned-to <userId>`; new `assign <followUpId>` subcommand with `--to <userId>` / `--unassign`; `renderFollowUpLine` shows assigned/unassigned + author; `renderInteractionLine` shows author. `team` commands now use `assertCanRemoveMember`/`assertCanChangeRole` + `removeMemberAndReassign` with `bootstrapScope`, printing reassigned count, enforcing break-glass/last-owner and owner-only owner transfers.
- Tests: new adversarial suite `workspaces/team-collaboration.test.ts` — role matrix (owner can promote to owner, admin cannot assign owner, member/viewer cannot change roles, viewer cannot remove, break-glass cannot be removed/demoted, last owner protection, owner transfer flow), assignment cross-workspace isolation (assigned/unassigned filters isolated per workspace, removal unassigns only within workspace, assign rejects cross-workspace), audit viewer workspace scoping (scoped to workspace, unscoped resolves to bootstrap, member removal audit searchable). New `crm/follow-ups-assignment.test.ts` — default unassigned compat, assigned/unassigned/assignedToMe filters, assign/unassign flips, `unassignFollowUpsForUser` only touches pending, single-workspace single-member compat. Migration test for `0012` in `packages/db/src/migrations.test.ts`.
- Compatibility guarantee preserved: single-workspace single-member behaves identically to v2.5 — all existing follow-ups remain unassigned (NULL), existing queries without assignment filters return same rows, `bootstrapScope`/`resolveScope` default to bootstrap workspace.

### Added — Phase 2 (complete): workspace-scoped engine & surfaces

- Scope helpers in `@netpro/core/workspaces` (`bootstrapScope`, `resolveScope`,
  `workspacePredicate`) — every core query now carries an explicit
  `workspace_id` predicate, resolved to the bootstrap workspace when no scope is
  supplied (single-owner installs behave exactly as before).
- The shared CRM (contacts/interactions/follow-ups/timeline/activity/contact
  resolution) is now workspace-scoped end to end: resolves, lists, stats,
  recompute, follow-up buckets and lifecycle, and the activity log all filter by
  scope, and writes stamp `workspace_id` + the author from the authenticated
  principal.
- Authorship migration `0010_authorship` (both dialects): `created_by_user` on
  `interactions` and `follow_ups` plus author indexes.
- Workspace default migration `0011_workspace_default` (both dialects):
  backfills any `workspace_id` NULLs into the bootstrap workspace and, on
  PostgreSQL, attaches a DB-level `DEFAULT 'default'` to `workspace_id` on
  every data table. Phase 1's `0008` left the column nullable with no default,
  so Postgres inserts that omitted `workspace_id` produced NULL, which the
  scoped queries then hid; this keeps single-owner installs v2.5-compatible.
- Web: `requireScope()` in `apps/web/lib/authz.ts`; **every** API route and
  every `(app)` page now derives the scope from the session and passes it into
  core — CRM, analytics, search, views/card, content, graph edges, events,
  campaigns, outreach, skills, enrichment, import/export included.
- Every remaining core module is now scope-aware: analytics overview &
  retention-sensitive views, hybrid search arms (FTS + semantic), views/beacon
  ingestion and purge, content repository (items/metrics/mentions), graph
  edges & provenance, events + attendee matching, campaigns (drafts,
  recipients, merge rendering), skills profiles, and the GDPR retention purge.
- CLI: all commands thread the caller's workspace through `resolveCliScope()`
  (`--workspace <id>` on any command, defaulting to the bootstrap workspace) —
  `track`, `outreach`, `path`, `analyze`, `card --views`, `edge`, `events`,
  `skills`, `campaign`, and `content` are scopes-compliant; single-owner use
  is byte-identical to v2.5.
- Cross-tenant scope-guard suite (`workspaces/scope-guard.test.ts`) asserting no
  workspace can read another's CRM rows, on the hermetic SQLite fixture.

### Added — Phase 4: encrypted web key vault

- Personal and workspace provider credentials in `/settings/keys`, encrypted
  at rest with AES-256-GCM and principal/slot-bound key derivation.
- Scoped management API with masked-only responses, bounded request bodies,
  member/admin write floors, and read-only env fallback without a master key.
- Vault-first credentials for outreach, AI skills, enrichment, and semantic
  search; CLI keychain behavior remains unchanged.
- Dual-dialect migration `0009_key_vault`, partial unique indexes for nullable
  workspace principals, and adversarial SQLite/API + live-Postgres CI coverage.
- Phase 4 follows Phase 1 as the roadmap's independent prerequisite for
  plugins. Phase 2's global tenancy work and the v3.0 release remain pending.

## [2.5.0] - 2026-09-09 — v2.5 (The Observer)

NetPro can now _observe_: who looked at your card, and how your cross-posted
content performs — without becoming a tracker itself. Everything below was
built to a privacy budget the code enforces, not a policy page: the raw IP
never reaches the database, the logs, or a backup; viewer hashes rotate daily
so nothing correlates across days; DNT/GPC requests get minimal rows; bots
and your own views never inflate the numbers; and both high-volume tables
purge themselves on a documented schedule.

### Added — v2.5 Phase 1: Profile views data model & privacy hardening

- Migration `0006` (both dialects) hardens the scaffold's producer-less
  `profile_views` table so Phase 2's beacon and Phase 3's analytics can
  trust it. New columns: `viewer_fingerprint` (24h dedup hash of
  IP + UA + accept-language), `is_bot` and `is_owner_view` (NOT NULL,
  default false), `session_id`, `duration_ms`, `utm_source` / `utm_medium` /
  `utm_campaign`, `viewed_card_id`. `viewer_ip` now stores only a 16-hex
  daily-salted HMAC — never a raw IP — and the migration **blanks legacy raw
  values** in place, because an upgrade cannot hash them without the
  operator's salt.
- Indexes: `idx_profile_views_time` (`viewed_at DESC`),
  `idx_profile_views_resolved` (partial, resolved contacts only),
  `idx_profile_views_page`, `idx_profile_views_fingerprint_time`, and
  `idx_profile_views_is_bot` (partial `viewed_at WHERE is_bot = false`).
- New `@netpro/core/views` module (`core.views`): daily-salted HMAC-SHA256
  hashing (`hashViewerIp`, `hashViewerFingerprint`, salt rotation per UTC
  day — no cross-day correlation possible), a vendored bot deny-list with a
  token backstop (`isBotUserAgent`), owner-view labeling via authenticated
  session or same-day same-IP heuristic (`shouldMarkOwnerView` — labels
  only, never blocks), and the 90-day raw-view retention purge
  (`purgeExpiredProfileViews`, default `VIEW_RETENTION_DAYS = 90`, to be
  scheduled with per-run `activity_log` logging in Phase 6).
- No new runtime dependencies (`node:crypto` only), no CLI/web surface yet —
  the beacon and analytics UI ship in Phases 2–3.

### Added — v2.5 Phase 2: Tracking beacon & ingestion pipeline

- **`profile_views` finally has a producer.** Two public beacon endpoints,
  both added to the edge proxy's `PUBLIC_ROUTES` (no session read at the
  edge, no cookies, no third parties):
  - `GET /api/card/pixel.gif` — a 1×1 GIF, always 200 and always
    `Cache-Control: no-store, no-cache, private`, even when rate-limited
    (429) or tracking is disabled. Params: `p` (page), `r` (referrer),
    `v` (signed contact token).
  - `POST /api/card/view` — JSON body (page, referrer, `durationMs`,
    `viewToken`) for browsers that can measure visit duration; `OPTIONS`
    answers 204 with CORS `*` so cross-origin embeds work. The body is
    capped at 8 KiB by streaming — oversize, non-JSON, and badly-shaped
    payloads get 415/400 before any parsing work.
- **The `/card` page sends exactly one beacon per visit:** a `<noscript>`
  pixel for non-JS clients, and in JS browsers a `pagehide`
  `navigator.sendBeacon` (with a `fetch` keepalive fallback) carrying the
  visit duration and the `?v=` token. Sending both would dedupe the second
  one away and lose the duration — so the page splits by capability
  (deviation from the plan, documented in the progress doc).
- **Ingestion hardening** (all in `@netpro/core/views` + `apps/web/lib/beacon.ts`):
  in-memory token-bucket rate limit of 60/min per salted IP hash (429
  beyond that, still the GIF); `viewed_page` snapped to an allowlist
  (`p=../../etc/passwd` → `/card`); referrer sanitized and capped at 200
  chars with its query string stripped; UTM merged from the beacon URL and
  the referrer, each field capped; geo from platform headers only
  (Vercel/Cloudflare), never a lookup; user-agent capped at 500 chars;
  `DNT: 1` / `Sec-GPC: 1` → minimal mode (the view is still counted, but
  geo, UA, referrer, UTM, duration and token resolution are dropped);
  dedup — same fingerprint within 5 min or same IP hash + page within 1 h
  is skipped with a reason instead of a row; `durationMs` clamped to one
  hour; the raw IP never touches the database or logs (daily-salted 16-hex
  HMAC only).
- **Signed `?v=` contact-resolution tokens:** `base64url(contactId|exp|HMAC-SHA256(NEXTAUTH_SECRET, contactId|exp))`,
  30-day cap, timing-safe comparison, and the referenced contact must
  still exist — otherwise `resolved_contact` is `null`, never an error. No
  path from IP or email to a contact.
- **Settings surface:** the card settings page gains a tracking panel with
  a copy-paste pixel snippet for blog/portfolio embeds and a disabled state
  when tracking is turned off.
- **Card HTML opt-in pixel:** `netpro card --pixel-url <origin>` renders an
  `<img>` view beacon for HTML cards and extends the card's CSP with
  `img-src <origin>` (default cards stay image-free); the URL must be
  absolute http(s), and the vCard command refuses the flag.
- **Operator controls:** `NETPRO_VIEW_SALT` (salt for the daily viewer
  hashes; falls back to `NEXTAUTH_SECRET`) and
  `NETPRO_DISABLE_VIEWS=true` (endpoints keep answering normally but write
  nothing).
- No database migration (Phase 1's `profile_views` is exactly the
  consumer) and no new runtime dependencies — `node:crypto`, `fetch`, and
  `sendBeacon` only.

### Added — v2.5 Phase 3: Viewer analytics surface (CLI + web + API)

- **Core `@netpro/core/views` analytics** (`views/analytics.ts`): the query
  side of `profile_views`, one composition (`getViewsOverview` → `{ stats,
recent, matches }`) that every surface shares so the CLI, the API, and the
  dashboard can never disagree.
  - `getViewStats` — windowed totals (views, unique viewers, resolved
    contacts, avg read duration), a zero-filled daily series, and
    referrer / country / page breakdowns. Uniqueness is
    `COUNT(DISTINCT COALESCE(viewer_fingerprint, viewer_ip, session_id))`,
    so DNT minimal rows (no fingerprint by design) and IP-less views still
    count sanely; referrers fold to hosts in JS (`blog.example/a` +
    `/post/2` → one `blog.example` bucket) because SQL cannot parse hosts
    portably.
  - `getRecentViews` — the newest-first timeline with resolved live
    contacts (a view attributed to a since-deleted contact renders
    unattributed) and limit/offset pagination.
  - `getTopReferrers` — the cheap single-query ranking the dashboard uses
    without paying for the full payload.
  - `getViewerContactMatches` — views attributed to known contacts via a
    signed `?v=` link, newest first; bots and owner views stay excluded
    even here (a crawler following a signed link is not a visit).
  - **Privacy rules enforced in the core, not trusted to callers:** bots
    and owner views are excluded unless explicitly opted in, and the
    excluded counts ride along in every payload; `days` is capped at the
    90-day retention window (asking for more would silently under-report
    purged history, so it is a `ViewsError` instead); future-stamped rows
    fall outside every window.
  - Portable SQL on both dialects (`viewed_at` is ISO text everywhere, so
    day bucketing is `substr(viewed_at, 1, 10)`); **~23 ms for the full
    stats payload at 10k views on SQLite**, against the plan's 100 ms
    budget.
- **CLI:** `netpro card --views [--days 30] [--limit 10] [--include-bots]
[--include-owner-views] [--json]` (summary + per-day bars + referrers +
  recent + known visitors; generation flags are refused in this mode, and
  generation stays offline — `--input` is now validated in code instead of
  by Commander so the two modes can have different requirements) and
  `netpro analyze --views` (the fifth mutually exclusive section flag;
  `--days` doubles as the views window here, default 30). The full
  `analyze` report and `--json` carry a `views` block too, and both text
  renderers share one `renderViewsSection`.
- **Web:** owner-only `GET /api/card/views?days=&limit=&offset=` (lenient
  params in the house style — garbage falls back, out-of-range clamps,
  the effective window echoed in `stats.window`; the proxy keeps it
  private while the beacons stay public, with a regression test that
  `/api/card/views` does not prefix-match public `/api/card/view`);
  `GET /api/analytics` gains the `views` block with a `?views=0` opt-out;
  `/dashboard` gains a "Profile views" strip (totals, server-rendered
  SVG sparkline, top referrers, recent views with contact links,
  onboarding empty state); `/settings/card` gains the analytics section
  (7/30/90-day links, show/hide-bots toggle, stat cards, per-day table,
  referrer/country tables, recent timeline, known visitors — tables, no
  chart library, no client JS).
- No database migration and no new runtime dependencies.

### Added — v2.5 Phase 4: Content tracker data model & provider interface

- **Migration `0007` (both dialects):** three new tables for the
  cross-posting tracker. `content_items` (`url` as given, `url_norm`
  UNIQUE canonical key, `title`, whitelisted `platform`, nullable `type`,
  `published_at`, `author`, JSON `tags`, `summary`, `source`), append-only
  `content_metrics` snapshots (`fetched_at`, `source`, nullable
  views/likes/comments/shares/bookmarks — `null` means unreported, never
  zero — plus an optional JSON `raw_payload`), and `content_mentions`
  linking content to contacts with a free-text `context` (composite PK).
  Indexes: `idx_content_items_platform`, `idx_content_items_published`
  (`published_at DESC`), `idx_content_metrics_item_time`
  (`(content_id, fetched_at DESC)`), `idx_content_metrics_time`, and both
  `content_mentions` directions.
- **New `@netpro/core/content` module** (`core.content`), dependency-free
  except the already-present `papaparse`:
  - `urls.ts` — the one URL canonicalizer: absolute http(s) only,
    lower-cased host, default ports dropped, fragment dropped, trailing
    slashes stripped, `utm_*`/ad-click params stripped with survivors
    sorted (scheme is identity — http and https stay distinct);
    host-suffix platform detection and strict platform parsing.
  - `parse.ts` — alias-tolerant CSV reader (per-row errors/warnings, bad
    dates warn + import undated, unknown types warn + null, 1,000-row
    cap) and a dependency-free RSS 2.0/Atom reader (CDATA, entities,
    `rel="alternate"` links, categories→tags, RFC 2822 dates, untitled
    entries fall back to the link, link-less entries skipped with a
    warning), plus `fetchFeedText` — the module's only network call,
    with injectable fetch, timeout, and byte caps.
  - `providers.ts` — the `ContentProvider` seam: `manual` (always works,
    hence no `fetchMetrics`) and `rss` (parses, never reports metrics)
    built in; `devto`/`twitter`/`github` as disabled stubs whose
    `fetchMetrics` throws `not_configured` naming the key that would
    enable it (`DEVTO_API_KEY`, `TWITTER_BEARER_TOKEN`, `GITHUB_TOKEN`).
    Routing is most-specific-first with `manual` as the eternal fallback.
  - `repository.ts` — strict `addContentItem` (`conflict` on dup) and
    idempotent `upsertContentItem` (re-imports report `existing` and
    never overwrite owner edits), filtered/paginated `listContentItems`
    (platform, case-insensitive tag, days window, query — `lower()` both
    sides so SQLite and Postgres agree), id-or-URL `resolveContentRef`,
    `getContentItem` detail payload, explicit-children-first
    `deleteContentItem`, append-only `recordMetrics` (≥1 metric
    required, backdating allowed, payload must be JSON-serializable),
    oldest-first `getContentMetricsSeries`, three-query
    `getContentOverview` (windowed totals, top 5 by latest views,
    platform breakdown, `excludedUndated` stated), `importContent`
    (CSV/feed/`rows`, overrides, `--dry-run` semantics), idempotent
    mentions (`add`/`remove`/`listContentMentions`/`listContactContent`,
    live contacts only), and `contentStatus`.
  - Reads are portable raw SQL (row-value latest-snapshot comparison,
    `ESCAPE '\\'` LIKE, `(published_at IS NULL)` ordering); writes go
    through Drizzle with JSON stringified on Postgres only.
- Incidental hardening: the 0005/0006 upgrade fixtures asserted
  journal-relative lengths, so adding 0007 broke them (and the 0006
  tag-prefix filter leaked the new migration into its pre-upgrade
  fixture); all three now assert explicit migration idxs.

### Added — v2.5 Phase 5: Content analytics surface (CLI + web + API)

- **`netpro content` (18th top-level command)** with seven subcommands,
  all with `--json`: `list` (platform/tag/days/query filters, engagement
  per row from the same batched summaries the API list answers with),
  `add` (idempotent on the normalized URL), `show` (detail + series with
  `--metrics`, id-or-URL selector), `import` (CSV/feed file or `--rows`,
  `--dry-run` previews), `fetch` (manual snapshot flags; the auto path
  resolves providers and explains `not_configured`), `rm`, and `analyze`
  (windowed overview with an explicit all-time-onboarding vs
  windowed-empty distinction).
- **Owner-only `/api/content` API**: `GET` lists items with latest
  snapshot, snapshot count and live-mention count attached (50 default /
  100 max, days window clamped 1–365, unknown platform → 400 naming the
  whitelist); `POST` adds one piece idempotently (duplicate → 201 with
  `created: false`, existing row untouched) or imports a CSV / feed XML
  body, `?dryRun=1` previews, multipart file uploads capped at 1 MiB,
  per-row errors/warnings reported, 413/415/400 discipline from the shared
  request helpers.
- **Owner-only `/api/content/[id]` API**: id-or-exact-URL selectors
  (tracking junk tolerated via the same canonicalizer the dedupe key
  uses); `GET` detail + mentions, `DELETE` removes the item with its
  snapshots and mentions explicitly. Sub-routes
  `/api/content/[id]/metrics` (`GET` series oldest-first, `POST` append a
  manual snapshot — ≥1 metric, never an update) and
  `/api/content/[id]/mentions` (`POST`/`DELETE` link/unlink a contact by
  id, email or exact name; ambiguous names → 400, never a guess).
- **`/content` (list page)** — GET-form filters (platform, 7/30/90-day
  window, exact tag, title/URL/author query), status line, engagement per
  row, and the "At a glance" overview (top performers by latest-known
  views + platform breakdown) that mirrors the CLI and the dashboard.
- **`/content/[id]` (detail page)** — the piece's URL/tags/summary, its
  latest snapshot and full history in tables, its contacts with contexts
  and unlink actions, a snapshot form, an add-mention form, and delete.
  Missing metrics render "—": unreported never looks like zero.
- **Contacts pages now list the content a person is part of**
  (`/contacts/[id]` "Content" section), and **the dashboard gets a
  "Content" strip** (items · measured · latest-known views · platform mix
  · top 3), hidden until the first item exists; content tables join the
  dashboard test teardown.
- **Nav & edge**: "Content" in the app nav, `/content` under the
  authenticated `/login` redirect in the edge proxy (with the API 401/200
  rows covered by `proxy.test.ts`).
- Core follow-up: the three-query enrichment behind `getContentOverview`
  was factored into `enrichSummaries` and exposed as
  `listContentSummaries`, so the list surfaces read engagement with three
  batched `IN` queries, never per-item round-trips.

### Added — v2.5 Phase 6: Cross-cutting — dashboard integration, retention & performance

- **Dashboard integration:** the content overview joins `getNetworkOverview`
  as a first-class `content` block (all-time, beside the Phase 3 `views`
  block), with `includeContent` / `?content=0` on `GET /api/analytics` — the
  same opt-out pattern as `graph=0` and `views=0`, so API clients can slim
  the payload while the dashboard reads the full thing. `/dashboard` now
  renders its "Content" strip from `overview.content` (one shared payload,
  no second `getContentOverview` round-trip), and the strips gain the
  two-step onboarding empty states: **"Add your first content"** (link to
  `/content`) when the library is empty, and **"Publish your card and share
  the link"** (link to the tracking panel) when there are no views.
- **Retention & privacy — the daily purge job** (`@netpro/core/retention`,
  in-memory, no queue infra, no migration): `purgeExpiredContentMetrics`
  (new, beside Phase 1's `purgeExpiredProfileViews`) deletes `content_metrics`
  snapshots older than 365 days — **but the latest snapshot per content item
  always survives**, even when it predates the window (ties for newest all
  survive; ambiguous latest is not guessable) — and `runRetentionPurge`
  composes both purges (90 d views / 365 d snapshots) behind a 24 h guard:
  it reads the newest `retention.purge` row from `activity_log` and skips
  when younger than the interval. Every run writes exactly one audit row
  with the deleted counts (never one row per row). The web process starts
  the schedule in `instrumentation.ts` after the startup migrations,
  independent of `NETPRO_AUTO_MIGRATE` (it is DML, not DDL), with a 24 h
  unref'd interval for long-lived containers: a Docker instance purges at
  boot + daily, serverless cold-start storms collapse into one purge per
  day (a same-second race deletes twice, idempotently, and logs twice).
  Operator knobs: `NETPRO_DISABLE_RETENTION`, `NETPRO_VIEW_RETENTION_DAYS`,
  `NETPRO_CONTENT_METRIC_RETENTION_DAYS` (garbage/zero/negative values fall
  back to the defaults — a typo must not widen the window). The Settings →
  Card tracking panel now documents the _effective_ windows (and the
  content-snapshot horizon) from that same config, so UI and job agree.
  `GET /api/card/pixel.gif` keeps its guarantees under test: no `Set-Cookie`,
  no raw IP in any stored column — and now a regression test that the raw IP
  never reaches the server logs either.
- **Performance budget (recorded on SQLite at 10k views + 1k content items
  - 5k metrics, 500 contacts / 100 edges):** `GET /api/analytics`
    (full dashboard payload, graph included) **~53 ms** (budget 500 ms),
    `GET /api/card/views` **~10 ms** (budget 100 ms), `GET /api/content`
    **~1–2 ms** (budget 100 ms). No new indexes were needed. The budget
    ships as a hermetic test (`perf.budget.test.ts`) with 10× smoke-alarm
    assertions, so a 10× regression fails the build and 15% jitter does not.
- **Docs:** `docs/getting-started.md` gains the content cookbook (add /
  CSV + feed import / manual snapshots / analyze) and the profile-views
  guide (embed snippet, signed `?v=` links, DNT behaviour, operator
  controls); `docs/deployment.md` gains the content-provider env table
  (`DEVTO_API_KEY` / `TWITTER_BEARER_TOKEN` / `GITHUB_TOKEN` — reserved,
  disabled stubs) and the retention section (windows, cadence, concurrency
  notes, knobs); `.env.example` documents both.
- No database migration and no new runtime dependencies.

### Added — v2.5 Phase 7: Release readiness & the `2.5.0` cut

- **The live-PostgreSQL performance pass now measures the Observer.** On top
  of the v2.0 fixture (5k contacts / 20k edges), the same release-gate
  database carries **10k profile views, 1k content items and 5k engagement
  snapshots**, and the pass times what those endpoints actually cost on a
  real query planner: full dashboard payload (graph + views + content
  included) **~485 ms** (budget 500 ms), the dashboard without its three
  heavy sections **~67 ms**, the views overview behind
  `GET /api/card/views` **~16 ms** (budget 100 ms), the content list behind
  `GET /api/content` **~5 ms** and its "At a glance" overview **~41 ms**
  (budget 100 ms). The pass also asserts correctness on the live planner —
  exact windowed view totals (bots and owner views excluded), distinct
  resolved contacts, zero-filled 30-day series, and `withMetrics` on the
  content overview — because the views module had no dedicated
  live-Postgres suite at Phase 6's end. Phase 7 then added one for the
  _ingest_ side too, after the Docker smoke caught the bug described under
  **Fixed**. Measured on PostgreSQL 18.4, medians of 3 runs;
  recorded in the
  [Phase 7 progress doc](docs/superpowers/plans/2026-09-09-v2.5-phase7-release-progress.md)
  and `docs/deployment.md`. The Phase 6 hermetic SQLite budget test is
  unchanged and still runs in every `npm test`.
- **CI's Docker smoke covers the new boundary — and caught a real bug.** The
  owner-only routes added since v2.0 (`/api/analytics`, `/api/card/views`,
  `/api/content` and its sub-routes) must answer 401 in a real production
  build, while the public beacons must behave like public surfaces:
  `GET /api/card/pixel.gif` answers 200 with `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff` and never sets a cookie;
  `POST /api/card/view` accepts a minimal beacon (200) and its CORS
  preflight answers 204 — in the image, not only in unit tests. The beacon
  check failed on its first run, exposing the Postgres ingest bug fixed
  under **Fixed** below.

### Changed — v2.5

- Version bump `2.0.0` → `2.5.0` across every workspace package, the
  internal `@netpro/*` ranges, the lockfile, and the CLI
  (`netpro --version` now reports `2.5.0`, asserted by test) — the
  three-part edit every cut in this repo has been (versions, internal
  ranges, lockfile), done so `npm ci` keeps resolving the workspace
  packages. No migration, no dependency changes.
- `docs/deployment.md` now records the v2.5 live-Postgres latencies beside
  the v2.0 graph numbers, so the two release gates are readable in one
  place; the settings tracking panel already promised the same retention
  horizons the purge job enforces (Phase 6).

### Fixed — v2.5

- **Beacon ingestion failed on every PostgreSQL deployment** (`v2.5 Phase 7`
  fix, found by the new Docker smoke at the release gate). The dedup probe in
  `recordView` used its nullable parameters only inside `IS NOT NULL`, from
  which Postgres cannot infer a parameter type — the query failed
  server-side ("could not determine data type of parameter $2") on every
  ingest, so `POST /api/card/view` answered 500 and the pixel silently
  dropped its write behind its always-200 contract. SQLite does not
  type-check bind parameters, so every hermetic test passed; the fix is an
  ANSI `CAST(… AS text)` around each nullable parameter, a semantic no-op
  that gives the planner a type. A new live-Postgres suite
  (`packages/core/src/views/postgres.integration.test.ts`, wired into CI's
  postgres job) runs the whole ingest path against a real server — dedup
  windows, DNT-minimal rows, owner/bot labeling, signed-token resolution,
  and the analytics totals over exactly those rows — so the ingest SQL can
  never again be dialect-verified on SQLite alone.

### Deferred — v2.5 deliberately does not ship

- **Cross-day viewer tracking of any kind.** Viewer hashes are HMACs under a
  salt that rotates every UTC day; the fingerprint column exists only to
  dedupe a 24-hour window, and retention deletes the raw rows after 90 days.
  A persistent viewer identifier would be trivial to add and is exactly what
  this milestone refuses to be. Raw IPs are never stored, logged, or
  shipped to a third party — and the upgrade blanks any legacy raw values
  migration `0006` found.
- **Contact resolution from IP, email, or user agent.** The only path from a
  view to a known contact is the owner's own signed `?v=` link (HMAC,
  30-day cap, contact must still exist). "Who viewed your profile" shows you
  who you _sent the link to_ — it never deanonymizes strangers.
- **Platform metric integrations.** `devto` / `twitter` / `github` content
  providers ship as disabled, self-explaining stubs that name the env key
  which would enable them (`DEVTO_API_KEY`, `TWITTER_BEARER_TOKEN`,
  `GITHUB_TOKEN`). Manual snapshots and RSS/Atom parsing are the shipped
  producers; no provider is ever called automatically — fetching is an
  explicit CLI/API action, and there is no background fetch cron.
- **A views analytics cookie, third-party script, or off-site beacon.** The
  pixel is first-party, cookieless, and the ingest endpoints set no cookies;
  the embed snippet is one `<img>` plus an optional inline `sendBeacon`,
  both pointed at the operator's own origin.
- Carried over from v2.0 (unchanged): live event discovery providers, a
  native `pgvector` column + ANN index, AI skills extraction by default,
  graph caching, SMTP delivery, and per-user encrypted web key storage /
  the `$EDITOR` draft-review loop.

## [2.0.0] - 2026-09-08

### Added — v2.0 Phase 6: Event matcher

- No migration: Phase 1's `events` / `event_attendees` tables finally have a
  producer. New `@netpro/core/events` module — CSV import, attendee matching,
  overlap, and recommendations.
- Import: alias-tolerant headers (`Event Name`, `starts_at`, `Attendee
Emails`, `names`…), attendees split on `, ; |` and newline, and dates
  normalized to UTC ISO. Unparseable or ambiguous dates (`14/03/2026`,
  `2026-02-31`) are **rejected per row** rather than guessed. Imports are
  idempotent — events dedupe on normalized name, attendance on
  `(event, contact)` — and support `--dry-run` / `{ dryRun: true }`.
- Matching is three explainable tiers: exact email (1.0), exact name (0.9 —
  accent-, case- and punctuation-insensitive), last name + first initial
  (0.6, reported as `review` and never linked unless asked). Anything with
  more than one plausible contact is `ambiguous` and is returned with its
  candidates; a line whose email and name disagree is ambiguous too. No code
  path picks between two people.
- **Imported `met_at_event` edges are `pending`** (`source = event_import`):
  an attendee list is evidence of attendance, not of a meeting. Manual links
  (`netpro events link`, the web form) are `confirmed`. Pairwise linking is
  capped at 250 edges per event per run and reports `edgeCapReached` when it
  stops. Attendance for an event that has not started is recorded as
  `planned` (`attended = false`).
- Attendee lines that match nobody are parked per event in `activity_log`
  (`action = events.unmatched`, replaced each run) — no new table — so they
  can be re-checked after importing new contacts or linked by hand.
- `recommendEvents` ranks events `0.6 × peers` (how many of your contacts
  went; 5 saturates it) `+ 0.2 × industry` (share of your network in the
  attendees' industries) `+ 0.2 × timing`, returns the reason for every
  component, and drops empty past events. Timing is UTC-day granular so a
  page cannot print "in 7d" and "starts in 6 days" for one event.
- CLI (17th command): `netpro events list|show|add|import|match|link|unlink|
recommend|rm`, each with `--json`; event selectors take an id or an exact
  name and refuse to guess between same-named events.
- Web: `/events` (list, filters, **Where to go next** recommendations with
  reasons, add form, CSV import panel that previews first and names ambiguous
  rows), `/events/[id]` (attendee overlap strongest-tie first, industries and
  companies, the unmatched bucket with per-row linking, a re-match panel, and
  delete), an **Events** section on `/contacts/[id]`, an **Events** nav link,
  `/events` in the proxy's protected routes, and the owner-only APIs
  `GET/POST /api/events`, `GET/DELETE /api/events/[id]`,
  `POST /api/events/[id]/match` and `POST/DELETE /api/events/[id]/attendees`.
  `EventError` now maps to HTTP the way `CrmError` and `GraphError` do
  (400 / 404 / 409; ambiguity is 400 everywhere).
- Live event _discovery_ (Luma/Eventbrite) is **not** shipped: it lands as a
  `EventDiscoveryProvider` interface with a disabled default, so a provider
  can be added later without touching the core, the CLI or the web.

### Added — v2.0 Phase 5: Skills gap analyzer

- Additive migration `0005` (both dialects) adds a nullable
  `contacts.skills` text column holding the derived verdict as a JSON array
  of canonical taxonomy names. Imported source fields are never modified.
- New `@netpro/core/skills` module: an embedded taxonomy (~100 skills in 12
  categories with an alias table — `k8s` → `kubernetes`, `data engineer` →
  `data engineering`), whole-token extraction from headline, role,
  department, industry, tags, custom fields and notes with per-skill
  **evidence** (`field`, matched alias, snippet) and confidence, an optional
  AI pass that may only choose from the taxonomy, `parseTarget` /
  `gapAnalysis` (`present`, `partial` + `partialVia`, `missing`,
  `matchScore = (present + ½·partial) / required`), `analyzeNetworkGaps`
  (per-skill coverage, gaps nobody covers, ranked candidates) and
  `networkSkillCounts`. Ambiguous bare words (`go`, `excel`, `spark`, `swift`,
  `growth`, `operations`, `strategy`) only match in prose through an
  unambiguous alias, but count as explicit tags or `--skills` values.
- Persistence: `extractSkillsBatch` stores the verdict on the contact and the
  full extraction in `enrichments` (`provider = skills_heuristic | skills_ai`,
  `data_type = skills`, one row per contact per extractor, replaced on
  re-run), bumps `updated_at` and writes a `skills.extracted` activity-log
  row **only when the verdict changes**, and refreshes the keyword search
  index for changed contacts (best-effort, never an embedding call).
- Search: `contacts.skills` is part of the indexed document, and a new
  `skills` filter (`netpro search --skills python,k8s`, `GET /api/search?skills=`)
  requires every listed skill; a name outside the taxonomy matches nothing
  rather than silently widening the result.
- CLI (16th command): `netpro skills <contact>` (stored + current skills with
  evidence), `netpro skills gap --role --description --skills [--contact]
[--limit] [--json]`, `netpro skills extract [--mode heuristic|ai] [--contact]
[--limit] [--dry-run] [--provider]`, `netpro skills status`. `--mode ai`
  reuses the outreach credentials (keychain / env) and fails before touching
  the database when no key is configured.
- Web: `/skills` (target form, coverage table with contact + warm-intro links,
  gaps, ranked matches, a "Derive skills" panel, and a network skill map when
  no target is given), skill tags with evidence on `/contacts/[id]` (stored
  skills the current text no longer supports are marked), a **Skills** nav
  link, `/skills` in the proxy's protected routes, and the owner-only APIs
  `GET /api/skills/gap?role=&description=&skills=&contact=&limit=` (unknown
  contact → 404, ambiguous → 400 via the shared resolver) and
  `GET|POST /api/skills/extract` (`{ mode?, contact?, dryRun?, limit? }`; AI
  keys come from the server environment only).
- Decision (plan open question #3): **AI extraction is default-off.** The
  heuristic pass is the product; the model is a bounded, opt-in bonus.

### Added — v2.0 Phase 4: Hybrid search

- Additive migration `0004` (both dialects) turns `search_index` into a real
  index: `search_text`/`content_hash`/`embedding` columns, an FTS5 virtual
  table with `unicode61 remove_diacritics 2` + sync triggers on SQLite, and a
  generated `search_vector tsvector` with a GIN index on Postgres. v1 portable
  search keeps working untouched on an un-migrated or un-indexed database.
- `searchContacts()` is now a dispatcher over three arms behind the **same
  entry point and the same filters**: portable substring (always), keyword
  full-text (`bm25()` / `ts_rank`, prefix matching), and an opt-in semantic
  arm. Results are merged with **reciprocal rank fusion** (`k=60`, weights
  keyword 1 / semantic 0.9 / portable 0.5) and deduped per contact. Every
  response carries an `engine` report naming which arms ran, how many hits
  each returned, and _why_ one was skipped.
- The keyword arm indexes the full contact document — name, email, headline,
  company, role, seniority, department, industry, location, country, tags and
  **notes** — so it finds people the six-column substring search cannot.
- `netpro reindex [--embeddings] [--force] [--status]` builds and inspects the
  index; it is content-hash guarded, so re-running it is nearly free. Imports
  produce index rows automatically (best-effort — a failed index write never
  fails an import) and **never call an embedding provider**.
- CLI `netpro search --mode portable|keyword|hybrid` / `--semantic`, plus an
  `Engine: …` line explaining the result set. Web: an engine selector on
  `/search` (the semantic option is hidden unless the server has a key), a
  "Results powered by …" badge with actionable hints, `GET /api/search?mode=`
  (unknown mode → explicit 400, never a silent downgrade), and an owner-only
  `search` block in `GET /api/health?verbose`.
- New env, all optional and defaulting to off: `EMBEDDINGS_PROVIDER`
  (`openai|disabled`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`,
  `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_DIMENSIONS`. The CLI also reads them from
  the encrypted keychain (`netpro config set embeddings.key`). Keys stay
  server-side; the browser never receives one.
- **No configuration = no behaviour change.** No index → substring search; no
  key → no semantic arm; SQLite → keyword-only (no vector support); embeddings
  API down mid-request → keyword results with a stated reason, not an error.
- No new runtime dependencies (the embeddings client is fetch-only, mirroring
  the existing AI provider surface). Measured on 1,000 contacts: cold reindex
  85 ms, warm 10 ms, portable query 12 ms, keyword 14 ms, hybrid 33 ms.

### Added — v2.0 Phase 3: Warm-intro pathfinder surface

- The Phase 2 engine gains its decision layer in `packages/core/graph`:
  `planIntroPaths()` (selectors → ranked chains), `rankIntroPaths` /
  `scoreIntroPath` (score = 0.6 × weakest-tie + 0.4 × mean hop
  strength×confidence — deterministic, hand-tested), `defaultPathOrigin`
  (strongest tie, skipping the target itself), and `buildIntroAskInput`
  (feeds the Phase 4 compose pipeline — draft-only, BYO-key).
- `IntroPathNode` now carries `lastInteraction`, so every hop shows your
  relationship score **and** recency on both surfaces.
- CLI: `netpro path <target> [--from] [--max-depth n] [--relation r]
[--status s] [--alt n] [--draft] [--json]` — ranked k-shortest chains, the
  first ask to make, and an optional AI-drafted ask email. A failed `--draft`
  prints the plan and exits non-zero so scripts can tell.
- Web: `/graph` — server-rendered target picker (contact datalist + free
  selectors), ranked chain cards with per-hop provenance, and a one-click
  **Draft intro request** deep link that pre-fills the outreach composer
  (`/outreach?contactId=&context=&purpose=`). `/graph/<contactId>` shows one
  person's centrality, Louvain community, adjacency (pending rows included,
  so the page doubles as a confirmation entry point) and the suggestions
  they appear in.
- API (owner-only via the proxy, like every `/api` route):
  `GET /api/graph/paths?target=&from=&depth=&relation=&status=&k=` (unknown
  target 404, ambiguous selector 400, depth capped to 1–6 for the web while
  the engine/CLI keep the 1–8 range) and `GET /api/graph/overview`.
- No migration (Phase 1's `0003` covers everything read), no new runtime
  dependencies, and "auto-picking the intermediary" stays deferred per the
  plan: chains are **ranked**, the human chooses.

### Added — v2.0 Phase 2: Graph analytics engine

- `packages/core/graph` analytics: pure-TS **Louvain community detection**
  (no new dependency — decision + measurement in the phase progress doc),
  degree + **Brandes betweenness** centrality, and a **warm-intro pathfinder**
  (bounded BFS over `edges`; `maxDepth` default 4; one-way rows traversed
  one way only; `rejected` never; `pending` only via `status=all`).
- `getNetworkGraph()` — merged dashboard view: node/edge coverage,
  communities (modularity + labels), most-connected list, components, exact
  average path length, and warm-intro candidate pairs (contact → hub via the
  strongest intermediary). Over-budget graphs degrade honestly (documented
  caps: 50k edges, 1.5k-node betweenness, 600-node APL — each skip reported,
  never faked).
- `netpro analyze --graph` section (fourth mutually exclusive section flag);
  `--json` carries the graph payload.
- Web: `GET /api/analytics` now includes `graph` (`?graph=0` opts out) and
  `/dashboard` renders a server-rendered **Network graph** strip with
  onboarding empty state, pending-candidate nudge, and cap-notice degrade.
- `analytics/metrics.test.ts` and the CLI/web analytics test fixtures moved
  onto the migrated `createTestSqliteConn` fixture — no duplicated DDL.
- No migration: Phase 1's `0003` (columns + indexes) is all this reads.

### Added — v2.0 Phase 1: Edge provenance

- Additive migration `0003` (both dialects): `edges.source`, `edges.confidence`,
  `edges.status`, neighborhood/filter indexes, plus `events` and
  `event_attendees` (schema for Phase 6).
- `packages/core/graph`: confirmed/pending/rejected CRUD, symmetric-pair
  collapse, LinkedIn mutual-connection candidates (never auto-confirmed),
  two-column CSV import, and “also met at…” attendance that writes
  `met_at_event` edges.
- CLI: `netpro edge add|list|rm|import|merge|confirm|reject`.
- Web: `/edges`, `/api/edges`, contact-detail “Also met at…” panel.

### Changed

- Package versions moved from `1.5.0` to `2.0.0` across every workspace
  package to mark the milestone release. The CLI already reported `2.0.0`;
  the packages now agree with it. (Keeping `0.x` until an npm publish was the
  alternative — the v1.5 precedent of publishing the product milestone as the
  package version wins, so `netpro --version`, the tags and the packages all
  tell the same story.)
- `docs/deployment.md` gained operating notes for the v2.0 surfaces: the
  skills taxonomy and its opt-in AI pass, event CSV import (what lands
  `pending` and why), and graph sizing. `docs/getting-started.md` gained the
  events cookbook.
- CI's PostgreSQL job now also runs the v2.0 performance pass (5k contacts /
  20k edges) and asserts that the semantic arm needs no `pgvector` extension.

### Deferred — v2.0 deliberately does not ship

- **Live event discovery.** No Luma/Eventbrite scraping and no provider API
  calls: `EventDiscoveryProvider` ships as an interface with a disabled
  default, so a provider can be added later without touching the core, the CLI
  or the web.
- **A native pgvector column.** Embeddings are stored as portable JSON text
  and merged in the fusion step, so a managed Postgres without the extension
  is a fully supported deployment. A `vector` column + ANN index remains a
  later optimization, not a missing feature.
- **AI skills extraction by default.** The offline heuristic taxonomy is the
  product — explainable, with evidence per skill. `--mode ai` is opt-in per
  run, restricted to the same taxonomy, and degrades to the heuristic result.
- **Automatic graph caching or incremental recomputation.** The graph is
  rebuilt per request; ~50k edges is the documented comfort ceiling, and
  betweenness / exact average path length keep their own smaller node budgets.
- **Real SMTP delivery for campaigns** (unchanged from v1.5): NetPro drafts, a
  human sends. No stored mail credentials, no open/click/bounce tracking.
- **Per-user encrypted web key storage and the `$EDITOR` draft-review loop** —
  still deferred per the
  [Phase 4 design spec](docs/superpowers/specs/2026-09-06-v1.0-phase4-ai-outreach-design.md).

## [1.5.0] - 2026-09-07

### Added — Phase 7: CRM tracking & follow-up reminders

- Per-contact interaction history (`meeting`, `call`, `note`, `email_sent`,
  `email_received`, `linkedin_message`, `intro_made`) with whitelisted
  direction/channel vocabularies and length caps, backdating allowed.
- Relationship scoring (recency 40% / frequency 25% / depth 20% / richness
  15%, stored 0–1) recomputed on every logged interaction.
- Follow-up reminders: due-today / overdue / upcoming / completed views,
  complete, snooze (relative or absolute), cancel, and optional recurrence
  (`7d`, `30d`, …).
- Activity-log writes for every CRM mutation (the audit trail the schema
  always promised).
- CLI: `netpro track log|add|list|done|snooze|cancel`, with shared
  `resolveContactRef` selectors and `--json` output.
- Web: `/contacts` CRM table, `/contacts/[id]` timeline + log/schedule panel,
  `/api/contacts`, `/api/interactions`, `/api/follow-ups` (+ `[id]`), and a
  dashboard follow-up-due strip.
- Additive migration `0002` (nine portable indexes, both dialects).

### Added — Phase 8: draft-only batch campaigns

- `packages/core/campaigns`: template rendering with nine whitelisted merge
  variables and save-time validation, recipient snapshots (ids or saved
  search), lifecycle transitions with self-healing stats, daily-limit meter,
  drip scheduling, and sent/replied/skipped mutations.
- Every confirmed send logs a real `email_sent` interaction (feeding CRM
  scoring); a recorded reply logs `email_received` and cancels the drip.
- CLI: `netpro campaign list|create|add-recipients|show|activate|pause|
complete|archive|mark-sent|mark-replied|mark-skipped`.
- Web: `/outreach/campaigns`, `/outreach/campaigns/[id]`, `/api/campaigns`
  (+ `[id]`, `[id]/recipients/[recipientId]`).
- Still draft-only by design: no SMTP client, no stored mail credentials, no
  automatic sending, no open/click/bounce tracking.

### Changed

- `netpro campaign` replaced the `/outreach/campaigns` stub.
- Package versions moved from `0.1.0-alpha.0` to `1.5.0` across all workspace
  packages to mark the milestone release.
- `docs/getting-started.md` now documents `netpro track` and
  `netpro campaign` and no longer lists batch campaigns as "planned".

## [1.0.0] - 2026-09-06

### Added — Phases 1–6 (deployable v1.0)

- Phase 1: LinkedIn CSV import with dedup/merge, three-provider enrichment
  (Hunter.io, People Data Labs, Clearbit), CSV export.
- Phase 2: faceted people search (`netpro search`, `/search`,
  `GET /api/search`).
- Phase 3: network analytics — composite health score, activity/dormancy
  breakdown, growth series, diversity (Shannon entropy), company clusters,
  dormant-ties list (`netpro analyze`, `/dashboard`, `GET /api/analytics`).
- Phase 4: BYO-key AI outreach drafting (OpenAI-compatible + Anthropic over
  plain `fetch`), `netpro outreach`, `/outreach`, `POST /api/outreach`.
- Phase 5: owner-only profile card with published snapshot, `/card`,
  `/card/vcard`, and offline HTML/vCard generation (`netpro card`).
- Phase 6: one-click Vercel deploy, `netpro migrate`, production security
  headers, readiness-aware `/api/health`, hardened Docker Compose stack; fixed
  the concurrent-migration race (advisory lock) and the production
  `UntrustedHost` auth bug; `middleware.ts` → `proxy.ts` for Next.js 16.
- Dual-dialect Drizzle schema (SQLite/Postgres), owner-only GitHub OAuth via
  Auth.js, full monorepo CI (lint, typecheck, 592 tests, build, live
  PostgreSQL integration, Docker image builds).

## [0.1.0-alpha] - 2026-08-31

### Added

- Monorepo scaffold: Turborepo + npm workspaces, `apps/web` (Next.js +
  Auth.js), `apps/cli` (commander), `packages/core|db|ui|config`.
- Blueprint-aligned Drizzle schema (SQLite + Postgres dialects), migration
  runner, seeded fixtures, ESLint/Tailwind shared configs, CI skeleton.

[0.1.0-alpha]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v0.1.0-alpha
[1.0.0]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v1.0.0
[1.5.0]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v1.5.0
[2.0.0]: https://github.com/NiravRVaghasiya/NetPro/releases/tag/v2.0.0
