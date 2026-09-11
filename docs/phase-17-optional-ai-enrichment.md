# Phase 17 — Optional AI and Enrichment

**Branch:** `arena/01a08cf4-netpro`
**Follows:** [Phase 16 — CLI ↔ Web UI Integration](phase-16-cli-web-integration.md)

## Objective

Make external providers optional.

NetPro should function without:

```text
OpenAI
Anthropic
Hunter
People Data Labs
Clearbit
embedding providers
```

When configured, providers enhance functionality. When not configured:

```text
NetPro still runs.
```

The Web UI should clearly show provider status:

```text
AI
● Not configured

Enrichment
● Hunter configured

Embeddings
● Disabled
```

---

## What shipped

### Core (`packages/core/src/providers/index.ts`)

One registry answers "which providers are available, and what does that mean
for what NetPro can do right now?":

- `PROVIDER_CATALOG` — every provider NetPro knows about, with its category
  (`ai` · `enrichment` · `embeddings` · `content`), the env vars and CLI
  keychain slots that configure it, and a plain-language `purpose`. Every entry
  is `optional: true` — that is the phase, expressed as data.
- `resolveProviderStatus(env, { keychain })` → a total, pure snapshot:
  per-category state (`configured` / `not configured` / `disabled`), the
  provider list with **where a key came from** (`env` | `keychain` | `none`),
  `capabilities` for what works right now, `degraded` entries that say what is
  off and how to turn it on, and `warnings` for misconfiguration.
- `createEnrichmentProviders(env, { keychain })` — builds only the enrichment
  providers that are actually configured (dynamic imports, so a provider-free
  install never loads their network clients).
- `formatProviderStatus(snapshot)` — the CLI's text rendering of the plan's
  strips.

Two rules the module holds itself to:

1. **Never leaks key material.** The snapshot carries booleans and a source,
   never a value — asserted by a test that serializes a fully-configured
   snapshot and greps for every secret.
2. **Never throws for a missing provider.** An empty environment is a valid
   configuration: offline capabilities (`import`, `scan`, `keywordSearch`,
   `graphAnalytics`) are `available`, provider-backed ones
   (`semanticSearch`, `enrichment`, `aiOutreach`, `contentSync`) are `disabled`
   with a reason and an `enable` hint. A typo like
   `EMBEDDINGS_PROVIDER=voyage` is a `warning`, not a crash.

Embeddings keep their opt-in semantics: a bare `OPENAI_API_KEY` makes **AI**
configured but leaves **Embeddings ● Disabled**, because `EMBEDDINGS_PROVIDER`
must say `openai` before the semantic arm turns on.

### Server (`packages/server/src/routes/providers.ts`, `routes/enrich.ts`)

`GET /api/providers` is now a thin HTTP view of the core registry. The legacy
shape the Observatory and Scan view read is preserved (`enrichment`,
`ai`, `embeddings`, `search`, `providers`), and the Phase 17 fields are added
alongside it: `categories`, `catalog`, `capabilities`, `degraded`, `warnings`,
`runsWithoutProviders`.

`POST /api/enrich` no longer hand-rolls provider detection: it asks core for
providers (`createEnrichmentProviders`) and for configured-ness
(`resolveProviderStatus`). With none configured it still returns a **completed**
job with `providerConfigured: false` and `enriched: 0` — "no provider" is a
configuration choice the UI shows, not an error.

### CLI (`apps/cli/src/commands/status.ts`)

`netpro status` ends with the provider block, resolved from the environment
**plus the encrypted keychain** (`netpro config set enrichment.hunter …`):

```text
Providers (all optional — NetPro runs without them)
  AI           ● Not configured
  Enrichment   ● Hunter configured
  Embeddings   ● Disabled
  Content      ● Not configured
```

`netpro scan`/`netpro status --json` carry the same machine-readable snapshot.

### Web UI (`apps/web/components/provider-status.tsx`)

A pure server component that renders the plan's strips from
`GET /api/providers` — it reads no environment and holds no keys itself, so the
Web UI is never a second source of truth:

- the three primary strips (**AI** · **Enrichment** · **Embeddings**; **Content**
  too, since the registry knows about it), each with ● and its detail line;
- an expandable per-provider list ("configured (env)" / "not set" + purpose);
- "Off right now (NetPro stays fully usable)" — every degraded capability with
  its reason and the exact command/env var that enables it;
- warning banners for misconfiguration.

It appears in **Settings → AI & enrichment providers** and, compactly, on
**/scan** (where enrichment is most visible). When the NetPro server is not
running it says so — "Provider status is unavailable — start the NetPro server"
— instead of guessing from the Next.js process's own environment.

## Exit criteria (plan)

- [x] NetPro functions with no provider configured — `resolveProviderStatus` is
      total over any environment; `POST /api/enrich`, `POST /api/scan`, imports,
      search, and graph analysis all complete with zero keys, and both the CLI
      and the Web UI say plainly that they will.
- [x] Configured providers enhance — enrichment runs inside a scan when Hunter,
      PDL, or Clearbit is set; AI enables outreach drafts; embeddings enable
      semantic search (and are reported `● Disabled` until
      `EMBEDDINGS_PROVIDER=openai` plus a key are present).
- [x] The Web UI clearly shows provider status — `ProviderStatus` renders the
      plan's three strips on Settings and /scan, including what is off and how
      to switch it on.

## Tests

- `packages/core/src/providers/index.test.ts` — empty-environment capabilities,
  the plan's three strip wordings, env vs keychain sources, embeddings gating
  (bare `OPENAI_API_KEY` stays disabled; explicit provider + key enables),
  unknown `EMBEDDINGS_PROVIDER` reported not thrown, no secret in the
  serialized snapshot, and the CLI text format.
- `packages/server/src/api.test.ts` — `GET /api/providers` with keys set
  (correct capabilities, no secret on the wire), with nothing set (offline
  capabilities still `available`, every disabled capability explained), and
  `POST /api/enrich` succeeding with no provider configured.
- `apps/cli/src/commands/status.test.ts` — `netpro status` prints the provider
  block, marks a configured provider, and never prints the key.
- `apps/web/components/provider-status.test.tsx` — the three strips, the
  "how to enable" lines, no key material in the markup, warnings, the
  unavailable-server state, and the compact variant.
- `apps/web/app/(app)/settings/page.test.tsx` — Settings renders the strips from
  the server snapshot and degrades to a clear message when unreachable.
