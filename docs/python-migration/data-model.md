# Data model

Do **not** redesign the database because Python is being introduced. Phase 2 is:

```text
Existing DB  →  Python SQLAlchemy  →  Same data
```

Schema source: `packages/db/src/schema.sqlite.ts` and `schema.pg.ts` (mirrored). Migrations: `packages/db/migrations/{sqlite,postgres}/0000`–`0014`.

---

## Dialects

| | SQLite (default) | PostgreSQL |
| --- | --- | --- |
| Engine | better-sqlite3, WAL, `busy_timeout=5000`, `foreign_keys=ON` | `pg` Pool, postgres 16 |
| File / URL | `~/.netpro/netpro.db` (0600) | `DATABASE_URL` required when dialect=postgresql |
| JSON columns | `text` + `{ mode: 'json' }` | `text` storing JSON strings (not `jsonb` in Drizzle schema) |
| Booleans | `integer` mode boolean | native boolean |
| FTS | Virtual table `contacts_fts` (FTS5) + triggers on `search_index` | Generated `search_vector tsvector` + GIN |
| Embeddings | JSON text array of floats | Same — **no pgvector column** |
| Migrations journal | `__drizzle_migrations` | `drizzle.__drizzle_migrations` |
| Concurrent migrate | Single writer | Advisory lock `4027180651197143` |
| Backup | File copy | `pg_dump` / `pg_restore` |

Dialect is **never inferred** from `DATABASE_URL` alone. Precedence: `DB_DIALECT` env → `[database] dialect` → sqlite.

---

## Identity & time

| Concern | Policy |
| --- | --- |
| Row IDs | UUID strings (`crypto.randomUUID()`) |
| Installation id | `ins_` + hex (`packages/db/src/identity.ts`) |
| Access token | `np_` prefix, file `~/.netpro/keys/access-token` mode 0600 |
| Timestamps | ISO-8601 **text** on both dialects (`created_at`, `updated_at`, …) |
| Timezone | UTC. `daysSince` floors whole UTC days |
| Soft delete | `contacts.deleted_at` only. All reads of “live” contacts filter `IS NULL` |
| Workspace | `workspace_id` text, default `'default'`, FK to `workspaces.id` ON DELETE CASCADE |
| Authorship | `created_by_user` on interactions / follow-ups (nullable) |

**Exception:** leftover Auth.js tables (`user`, `account`, `session`, `verificationToken`) keep Auth.js column names (`emailVerified`, `sessionToken`, `timestamp_ms`). Phase 24 removed Auth.js from the app; the tables remain for migration compatibility. Do not drop them in early Python phases.

---

## Tables (27)

Counts match README (“27 tables, 15 mirrored migrations”). Plus SQLite-only virtual `contacts_fts`.

### Tenancy

#### `workspaces`

| Column | Type | Notes |
| --- | --- | --- |
| id | text PK | Bootstrap id `default` |
| name | text not null | |
| slug | text not null unique | |
| created_at | text | ISO |

#### `workspace_members`

| Column | Notes |
| --- | --- |
| id | PK |
| workspace_id | FK cascade |
| user_id | FK → `user.id` cascade |
| role | `owner \| admin \| member \| viewer` (default `member`) |
| created_at | |

Unique `(workspace_id, user_id)`. Hierarchy: owner (4) > admin (3) > member (2) > viewer (1). Last-owner guard in core, not a DB constraint.

#### `workspace_invites`

id, workspace_id, token (unique), role, expires_at, created_by, accepted_at, revoked_at, created_at.

---

### People & graph

#### `contacts`

Primary entity (“Person”).

| Column | Notes |
| --- | --- |
| id | UUID PK |
| workspace_id | default `default` |
| full_name | required |
| first_name, last_name | |
| email, email_verified | |
| phone, avatar_url | |
| headline, company, company_domain, role, seniority, department, industry | |
| location, country, timezone | |
| linkedin_url, github_url, twitter_url, website_url | |
| source | not null (`linkedin_csv`, `linkedin_url`, …) |
| source_id | |
| tags, custom_fields, skills | JSON text |
| notes | |
| relationship_score | real, **0–1** (score function is 0–100 / 100) |
| last_interaction | ISO or null |
| interaction_count | int default 0 |
| created_at, updated_at, deleted_at | |

Indexes: `relationship_score`, `last_interaction`, `workspace_id`, `(workspace_id, updated_at)`.

Seniority vocabulary (import normalize): `intern | junior | mid | senior | lead | director | vp | c_level`.

#### `interactions`

id, workspace_id, created_by_user, contact_id FK cascade, **type** (whitelist), direction, subject, content, sentiment, channel, campaign_id, occurred_at, created_at.

Types: `email_sent`, `email_received`, `meeting`, `call`, `note`, `linkedin_message`, `intro_made`, `follow_up_due`.  
Directions: `inbound | outbound`.  
Channels: `email | linkedin | twitter | in_person | phone | other`.

#### `edges`

id, workspace_id, source_id, target_id (both FK contacts), relation, strength (default 0.5), context, bidirectional (default true),

Provenance (v2.0):

| Column | Values |
| --- | --- |
| source | `linkedin_csv \| manual \| event_import \| skype_migrate` |
| confidence | 0–1, default 1 |
| status | `pending \| confirmed \| rejected` (default `confirmed`) |

`discovered_at`, `updated_at`.

**Trust rules (code, not CHECK):** rejected never enter analysis; pending excluded unless `status=all|pending`; self-edges and soft-deleted endpoints dropped.

Relations: `mutual_network | colleague | met_at_event | mutual_intro | manual`.

#### `follow_ups`

id, workspace_id, created_by_user, assigned_to, contact_id, reason, due_at, snoozed_until, status (`pending|completed|cancelled`), completed_at, recurring, recurrence_rule, created_at.

Snooze is a timestamp, not a status.

---

### Search

#### `search_index`

PK `contact_id` FK contacts. workspace_id, search_text, normalized facet columns (`company_norm`, `role_norm`, `location_norm`, `seniority_norm`, `industry_norm`), embedding (JSON text), embedding_model, embedding_dim, embedding_updated_at, content_hash, updated_at.

SQLite extra (migration 0004, **not** a Drizzle table): `contacts_fts` FTS5(`contact_id`, `search_text`) kept in sync by triggers.

Postgres extra: generated `search_vector tsvector` on `search_index`.

---

### Events & content

#### `events`

id, workspace_id, name, location, starts_at, ends_at, source (default `manual`), created_at.

#### `event_attendees`

PK `(event_id, contact_id)`, workspace_id, role, attended, discovered_at.

#### `content_items`

id, workspace_id, url, **url_norm unique** (canonical dedupe), title, platform, type, published_at, author, tags JSON, summary, source, created_at, updated_at.

Canonicalization: lower host, no fragment, strip tracking params, sort query — `content/urls.ts`.

#### `content_metrics`

id, workspace_id, content_id, fetched_at, source, views/likes/comments/shares/bookmarks (nullable), raw_payload JSON, created_at.

Retention: 365 days, **latest snapshot per item always kept**.

#### `content_mentions`

PK `(content_id, contact_id)`, workspace_id, context.

---

### CRM extras

#### `enrichments`

id, workspace_id, contact_id, provider, data_type, raw_payload JSON, confidence, fetched_at, expires_at, stale.

#### `campaigns`

id, workspace_id, name, description, status (`draft|active|paused|completed|archived`), type (`single|sequence`), template JSON, steps JSON, send_from, send_via (**always null** in draft-only mode), daily_limit default 50, counters (total_recipients, sent, opened, replied, bounced), timestamps.

Transitions: draft→active|archived; active→paused|completed|archived; paused→active|completed|archived; completed→archived; archived→∅.

#### `campaign_recipients`

id, workspace_id, campaign_id, contact_id, status (`pending|scheduled|sent|replied|skipped`), current_step, personalized_vars JSON, scheduled_at, sent_at, opened_at, replied_at, bounced_at, error_message.

Max 1000 recipients, 5 drip steps, delay 1–365 days.

#### `profile_cards`

id, workspace_id, draft JSON text not null, published JSON text, published_at, updated_at. Draft vs published so private edits never go live implicitly.

#### `profile_views`

Privacy-hardened (migration 0006):

- `viewer_ip` holds **HMAC-SHA256 digest**, not an IP (16 hex chars, daily salt)
- `viewer_fingerprint` 24h dedup under same salt
- `is_bot`, `is_owner_view` excluded from analytics
- `session_id` ephemeral reload dedup
- utm_*, viewed_card_id, viewed_page, viewed_at, country, city, duration_ms

Retention: **90 days** raw rows.

#### `activity_log`

id, workspace_id, action, entity_type, entity_id, metadata JSON, created_at.

Also the retention-purge **state**: last `action = 'retention.purge'` row.

---

### Platform

#### `plugins`

id, workspace_id, name, version, manifest JSON text, enabled default **false**, installed_from, installed_by_user, plugin_settings JSON, timestamps. Unique `(workspace_id, name)`.

#### `webhooks`

id, workspace_id, url, secret, event_allowlist JSON default `[]`, status (`enabled|disabled|paused`, default `paused`), timestamps.

#### `webhook_deliveries`

id, webhook_id, event, payload, status (`pending|delivered|failed|dead_letter`), received_at, response_code, error_message, attempt, max_attempts (8), timestamps.

Retention: **30 days**.

#### `key_vault`

id, workspace_id, user_id (null = workspace slot), key_name, ciphertext, last_four, created_at, updated_at, last_used_at.

Partial unique indexes: personal `(workspace_id, user_id, key_name)` WHERE user_id IS NOT NULL; workspace `(workspace_id, key_name)` WHERE user_id IS NULL.

Ciphertext: AES-256-GCM, 12-byte IV + 16-byte tag + body, base64. Key = SHA-256(`master:principal:netpro-key-vault-v1`) where principal is `JSON.stringify([workspaceId, userId, keyName])`. Master: `ENCRYPTION_MASTER_KEY` ≥ 32 chars.

---

### Auth.js leftovers (keep)

`user`, `account`, `session`, `verificationToken` — Auth.js adapter shapes. Not used by local-first auth. Required so existing databases open.

---

## Migrations (15 per dialect)

| # | File | What |
| --- | --- | --- |
| 0000 | `quick_iron_fist` / `new_cerise` | Base schema |
| 0001 | `profile_card` | `profile_cards` |
| 0002 | `crm_indexes` | CRM indexes |
| 0003 | `edge_provenance` | edge source/confidence/status |
| 0004 | `hybrid_search` | FTS5 / tsvector + embedding columns |
| 0005 | `skills` | `contacts.skills` |
| 0006 | `profile_views_privacy` | HMAC viewer columns, null legacy IPs |
| 0007 | `content_tracker` | content_* tables |
| 0008 | `workspaces` | workspaces + members + invites + workspace_id |
| 0009 | `key_vault` | `key_vault` |
| 0010 | `authorship` | created_by_user |
| 0011 | `workspace_default` | backfill default workspace |
| 0012 | `team_collaboration` | assigned_to, audit indexes |
| 0013 | `plugins` | `plugins` |
| 0014 | `webhooks` | webhooks + deliveries |

Journals: `migrations/*/meta/_journal.json`. **Applying twice is a no-op** (CI asserts this). Python Alembic must either wrap these SQL files or prove equivalent end-state; do not rewrite history of existing installs.

`pendingMigrationTotal` = number of journal entries (15). Health `migrations.applied` vs `expected`.

---

## Config file (not SQL)

`~/.netpro/config.toml` — strict subset: sections `[database]`, `[server]`, `[installation]`, `[auth]`; strings/numbers/booleans only. Unknown section/key is a **loud error**.

```toml
[database]
dialect = "sqlite"          # or postgresql
path = "netpro.db"          # sqlite, relative to NETPRO_HOME
# url = "postgresql://…"    # postgres

[server]
host = "127.0.0.1"
port = 3777
# allowed_origins = "https://ui.example.com"
# web_url = "http://localhost:3000"

[installation]
id = "ins_…"
created_at = "…"
# owner = "…"
# email = "…"

[auth]
mode = "local"              # local | token | open
```

---

## Domain objects vs ORM

Python should not leak SQLAlchemy models into FastAPI/CLI. Suggested mapping:

| Domain | Table(s) |
| --- | --- |
| Person | `contacts` |
| Relationship / Edge | `edges` |
| Interaction | `interactions` |
| FollowUp | `follow_ups` |
| Workspace | `workspaces` + members + invites |
| Skill | `contacts.skills` + taxonomy in code (`skills/taxonomy.ts`, 101 names) |
| Event | `events` + `event_attendees` |
| Content | `content_items` + metrics + mentions |
| Campaign | `campaigns` + `campaign_recipients` |
| Credential | `key_vault` (ciphertext never leaves infrastructure) |
| Plugin | `plugins` |
| Webhook | `webhooks` + `webhook_deliveries` |

Jobs and SSE events are **not** tables today.

---

## Indexes worth preserving

Do not drop these when generating Alembic:

- contacts: score, last_interaction, workspace, workspace+updated
- interactions: contact+occurred, campaign, workspace, workspace+contact, author
- edges: source, target, relation, confidence, status, workspace
- follow_ups: due, contact, workspace, workspace+status+due, assigned_to, …
- search_index: updated_at, workspace
- profile_views: time, resolved (partial), page, fingerprint+time, non-bot time (partial), workspace+time
- content: url_norm unique, platform, published
- key_vault: the two partial uniques
- plugins: workspace+name unique

---

## Sample fixture

CSV: [`fixtures/data/linkedin-connections.sample.csv`](fixtures/data/linkedin-connections.sample.csv)  
Graph golden: [`fixtures/data/graph-golden.md`](fixtures/data/graph-golden.md)

After Phase 2, a Python `netpro` equivalent should `init` + import that CSV and produce four contacts with sources `linkedin_csv`, `created_at` from `Connected On`, and pending mutual-network candidates only if the CSV contained a Mutuals column.
