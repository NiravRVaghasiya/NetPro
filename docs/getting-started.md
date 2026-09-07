# Getting Started

## Prerequisites

- Node.js >= 20
- Docker (only needed for the Postgres/self-hosted path)

## Install

```bash
npm install
```

## Run the web app (SQLite, local)

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev -w apps/web
```

Visit http://localhost:3000. The public card is unavailable until you explicitly
publish one. Private pages redirect to owner sign-in.

## Configure owner sign-in

NetPro v1 is a **single-owner** instance, not a multi-tenant service. Imported
contacts and integration keys are shared within that instance. Before signing
in, configure these values in `apps/web/.env.local` (or the production server
and Docker `.env`):

- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: credentials for your GitHub
  OAuth app, created in GitHub **Settings → Developer settings → OAuth Apps**.
- `NETPRO_OWNER_GITHUB_ID`: your numeric GitHub account ID, **not** your username
  or OAuth client ID. For example, retrieve it with
  `gh api users/YOUR_USERNAME --jq .id` (or view that user's public GitHub API
  response). No other GitHub account can sign in.
- `NEXTAUTH_SECRET`: replace the example value with a random secret generated
  by `openssl rand -base64 32`. Keep it on the server and out of Git.
- `NEXTAUTH_URL`: the externally reachable app origin. For local development,
  use `http://localhost:3000`. Register
  `http://localhost:3000/api/auth/callback/github` as the OAuth app callback;
  replace the origin with your HTTPS domain for a hosted instance.

Auth.js v5's `AUTH_SECRET` / `AUTH_URL` names are also supported. Behind a trusted
reverse proxy, configure its forwarded host/protocol correctly; set
`AUTH_TRUST_HOST=true` only when that proxy/host is trusted. Card writes enforce
same-origin requests using those headers.

Restart after environment changes. Missing or invalid owner configuration
**disables sign-in**, rather than allowing open registration. When upgrading
from Phases 1–4, existing sessions are invalidated and the owner must sign in
again. Changing the configured owner also revokes the old owner's sessions.
This controls access to the entire instance; it does not partition or erase
its stored data. Publicly published cards remain public until unpublished.

## Run the CLI

```bash
npm run build -w apps/cli
node apps/cli/dist/index.js --help
```

## Import your connections

```bash
node apps/cli/dist/index.js import --linkedin ~/Downloads/Connections.csv
```

The first run creates and migrates the local database (`./netpro.db`)
automatically. Re-importing the same file merges instead of duplicating.

## Enrich contacts (optional — requires your own API keys)

```bash
node apps/cli/dist/index.js config set enrichment.hunter YOUR_HUNTER_API_KEY
node apps/cli/dist/index.js config set enrichment.pdl YOUR_PDL_API_KEY
node apps/cli/dist/index.js config set enrichment.clearbit YOUR_CLEARBIT_API_KEY
node apps/cli/dist/index.js enrich --source all
```

Enrichment is BYO-key — without a configured key, each provider is skipped
(not an error). For the web app, set `HUNTER_API_KEY`/`PDL_API_KEY`/`CLEARBIT_API_KEY`
as server-side environment variables instead (see `apps/web/.env.example`).

## Export your contacts

```bash
node apps/cli/dist/index.js export --format csv --output contacts.csv
```

## Search your contacts

Free-text search plus faceted filters (all flags optional; combine freely):

```bash
# Free-text across name, email, company, role, headline, location
node apps/cli/dist/index.js search vercel engineer

# Filter by company / role / location / seniority
node apps/cli/dist/index.js search --company stripe --role engineer
node apps/cli/dist/index.js search --seniority c_level --has-email

# Minimum relationship score, recent activity, sorting, pagination
node apps/cli/dist/index.js search --min-score 0.5 --active-within 30
node apps/cli/dist/index.js search --sort name --limit 10 --offset 20

# Machine-readable output (contacts, total, facets)
node apps/cli/dist/index.js search stripe --json
```

Sort options: `relevance` (default), `score` (relationship score), `recent`
(last interaction), `name`. In the web app, use the **Search** page
(`/search`) — it has the same query/filter/sort/facet/pagination controls and
calls `GET /api/search`.

> Search runs in portable ANSI SQL on both SQLite and Postgres. The blueprint's
> hybrid FTS5 + vector-semantic search is a later phase; it builds on the same
> `searchContacts` core entry point.

## Analyze your network

```bash
# Full report: network score, activity, diversity, growth, clusters, dormant ties
node apps/cli/dist/index.js analyze

# Section views
node apps/cli/dist/index.js analyze --network-score
node apps/cli/dist/index.js analyze --clusters
node apps/cli/dist/index.js analyze --graph   # v2.0: Louvain communities, centrality, warm-intro candidates
node apps/cli/dist/index.js analyze --dormant --days 60 --limit 20

# Machine-readable output (the full overview payload)
node apps/cli/dist/index.js analyze --json
```

In the web app, the **Dashboard** page (`/dashboard`) renders the same numbers
from `GET /api/analytics`: metric cards, a 12-month growth chart, top
companies/industries, clusters, your reconnect list, and — since v2.0
Phase 2 — a **Network graph** section (Louvain communities, centrality,
components, and warm-intro candidates over your confirmed edges; `pending`
candidates stay out until you confirm them). Use **Graph** (`/graph`) to turn
those candidates into actual intro plans (see below).

> Analytics reads LinkedIn's "Connected On" date — imports record it as the
> contact's `createdAt` and initial `lastInteraction`, so growth reflects when
> relationships actually formed, not when the CSV was imported. Graph-native
> analytics and the pathfinder shipped with v2.0 Phases 2–3; per-contact
> relationship scoring comes from interaction logging (CRM).

## Graph edges (v2.0 Phase 1)

NetPro never silently infers that two of *your* contacts know each other.
Manual links are confirmed; LinkedIn “Mutual connections” columns become
**pending** candidates you confirm or reject.

```bash
netpro edge add "Jane Doe" "Pat Lee" --relation colleague
netpro edge list
netpro edge list --status pending
netpro edge confirm <edgeId>
netpro edge reject <edgeId>
netpro edge rm <edgeId>
netpro edge import edges.csv          # two columns: from,to
netpro edge merge                     # collapse A→B / B→A duplicates
```

The web UI is **Edges** in the navigation (`/edges`, `GET/POST /api/edges`).
On a contact page, **Also met at…** records event attendance and links them
to others already marked at that event.

## Find a warm intro (v2.0 Phase 3)

Once edges exist, NetPro finds the shortest chains of links to the person you
want to reach and names the first ask — ranked by your relationship strength
with each hop, never auto-picked:

```bash
netpro path "Zoe Zodiac"                            # start = your strongest tie (said out loud)
netpro path zoe@acme.com --from "Ada Lovelace"      # explicit start
netpro path "Zoe Zodiac" --alt 3                     # ranked k-shortest alternatives
netpro path "Zoe Zodiac" --max-depth 2 --relation colleague
netpro path "Zoe Zodiac" --status all                # preview pending candidates too
netpro path "Zoe Zodiac" --draft                     # AI drafts the ask email — you send
netpro path "Zoe Zodiac" --json                      # scriptable plan payload
```

Each hop prints your relationship score and last-touch date for the person,
plus the edge provenance walked to get there (`relation`, confidence,
one-way). `--draft` reuses the outreach credentials from `netpro config` /
the environment and remains **draft-only**: NetPro composes, you review and
send.

The web app has **Graph** in the navigation (`/graph`): a target picker
(search the contact list or type any name/email/id), the ranked chain cards,
and a one-click **Draft intro request** link that pre-fills the outreach
composer with the right recipient, context and ask. `/graph/<contactId>`
shows one person's centrality, community, and every link they have (pending
rows included, so you can confirm right there). The same data is available
over the owner-only JSON APIs `GET /api/graph/overview` and
`GET /api/graph/paths?target=&from=&depth=` (the web API caps depth at 6;
the CLI accepts the engine's full 1–8).

## Draft AI outreach

NetPro drafts personalized outreach from your contact data — **you** review and
send it (nothing is ever emailed automatically). Bring your own API key:

```bash
# CLI: store the key encrypted in ~/.netpro, or set OPENAI_API_KEY in the env
netpro config set ai.openai.key sk-...          # or: ai.anthropic.key
netpro outreach --to jane@stripe.com \
  --context "met at React Conf after the WASM talk" \
  --purpose "a 15-minute call about OSS collab" --tone warm

# Someone not in your network yet:
netpro outreach --name "Pat Lee" --email pat@newco.com --company NewCo --role CTO
netpro outreach --to "Jane Doe" --json           # scriptable JSON output
```

The web app drafts from the **Outreach** page (`/outreach`, backed by
`POST /api/outreach`) — pick a contact or fill in a new recipient, choose a
tone, and add context. Configure the server with `AI_PROVIDER`,
`OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`), optionally `OPENAI_BASE_URL` for an
OpenAI-compatible endpoint, and `OPENAI_MODEL`/`ANTHROPIC_MODEL` overrides; the
**Settings** page shows which integrations are configured.

## Track relationships & follow-ups

NetPro v1.5 keeps a per-contact interaction history — email, meetings, calls,
notes, LinkedIn messages, intros — with a computed relationship score, plus
follow-up reminders with due-today/overdue/upcoming views. The web CRM lives at
**Contacts** in the navigation (`/contacts`, `/contacts/[id]`); from the
terminal, `netpro track` speaks the same language:

```bash
# Log yesterday's coffee — meeting defaults to inbound + in_person
netpro track log "Jane Doe" --type meeting --note "Discussed OSS collab" --at 2026-09-06

# The blueprint's one-shot workflow: met at an event + schedule the follow-up
netpro track add "Jane Doe" --met-at "React Conf" --follow-up 7d
netpro track add "Pat Lee" --met-at "WASM meetup" --follow-up 2w --reason "share Drizzle talk"

# Where's the follow-up queue?
netpro track list                      # all pending follow-ups
netpro track list --due-today          # act on these first
netpro track list --overdue
netpro track list --upcoming --limit 50
netpro track list --recent             # recent interactions instead
netpro track list --contact "jane@stripe.com" --json

# Close the loop
netpro track done <followUpId>         # full id or unique prefix
netpro track snooze <followUpId> --for 3d
netpro track snooze <followUpId> --until 2026-10-01
netpro track cancel <followUpId>
```

`<contact>` selectors accept an email, contact id, or a unique full name
(ambiguous names list the candidates). Types are whitelisted
(`meeting`, `call`, `note`, `email_sent`, `email_received`,
`linkedin_message`, `intro_made`) and backdating is allowed — log it when it
happened, not when you remember it.

## Run draft-only batch campaigns

Personalize one message or a multi-step drip for a list of contacts — and
remember, **NetPro drafts, you send**. Every message is rendered per recipient
from whitelisted merge variables (`{{firstName}}`, `{{company}}`, `{{role}}`,
`{{headline}}`, `{{location}}`, `{{industry}}`, `{{email}}`, `{{fullName}}`,
`{{lastName}}`); no SMTP, no secrets, nothing leaves your machine automatically.
The web UI is at **Campaigns** in the navigation (`/outreach/campaigns`,
`/outreach/campaigns/[id]`); the CLI commands:

```bash
# Create a draft campaign: one message, recipients from a search snapshot
netpro campaign create --name "React Conf follow-up" \
  --subject "Great meeting you, {{firstName}}" \
  --body "Hi {{firstName}}, enjoyed our chat at React Conf — …" \
  --query "conf" --company Stripe --daily-limit 20

# Or a drip sequence with per-step delays (max 5 steps):
# --step DAYS:SUBJECT:BODY (delay is a whole number of days)
netpro campaign create --name "OSS collab drip" \
  --subject "Hi {{firstName}} — quick question" \
  --body "…" \
  --step "3:Quick nudge:Hi {{firstName}}, just following up on our chat…" \
  --step "7:Closing the loop:…" \
  --contact <contactId> --contact <contactId> --daily-limit 20

# Review the sequence, recipients, and every personalized draft
netpro campaign list
netpro campaign show <campaign>            # prints every rendered draft

# Your mailbox is the (only) sender — record the outcome here
netpro campaign mark-sent <campaign> <recipient>          # logs an email_sent interaction
netpro campaign mark-sent <campaign> <recipient> --force  # ignore the daily limit
netpro campaign mark-replied <campaign> <recipient>       # logs inbound reply, cancels drip
netpro campaign mark-skipped <campaign> <recipient>       # opt out; nothing logged

# Lifecycle: draft → active → paused → completed (archived from any state)
netpro campaign activate <campaign>
netpro campaign pause <campaign>
netpro campaign complete <campaign>
netpro campaign archive <campaign>
```

`<recipient>` accepts the same selectors as `netpro track` (email, contact id,
or unique full name). Recipients are snapshotted at creation (explicit ids or a
search snapshot), so a campaign is a commitment to a concrete list. Confirmed
sends and replies feed the same interaction history as `netpro track`, keeping
the relationship score and analytics true from one source of truth. Scheduled
drip times are advice shown in the UI — nothing is sent automatically.

## Create your profile card

After signing in, open **Profile card** in the navigation (`/settings/card`):

1. Enter your own public name, headline, biography, role/company/location, and
   optional email, phone, and up to six HTTP(S) links. Nothing is prefilled from
   your imported contacts or GitHub account.
2. Use the **Private preview** to review the card. **Save draft** persists edits
   without publishing them or changing an existing live card.
3. Check the publication confirmation and click **Publish card** (or **Publish
   changes**). The current form is saved and published together.
4. Share `/card`. Visitors do not need an account; **Save contact** downloads
   `/card/vcard` as a vCard 3.0 file.
5. **Unpublish** immediately makes both public URLs return 404. Your saved draft
   is retained; edits you have not saved also stay in the current editor.

Every filled field on a published card is public, including email/phone and
contact downloads. Private draft changes stay private until you publish again.
Cards request `noindex, nofollow` and do not track viewers or load third-party
images, but `noindex` is **not** access control. Unpublishing cannot revoke copies
that someone has already downloaded, cached independently, or screenshotted.

### Portable HTML and vCard (CLI)

Download **profile JSON** from the editor, or copy the fictional example in
[`docs/examples/profile.json`](examples/profile.json) and replace its details:

```bash
# Run from the repo root after building the CLI
node apps/cli/dist/index.js card --generate \
  --input docs/examples/profile.json --output card.html

# Export a vCard instead
node apps/cli/dist/index.js card --input docs/examples/profile.json \
  --format vcard --output contact.vcf

# Omit --output to write the generated file contents to stdout
node apps/cli/dist/index.js card --input docs/examples/profile.json
```

The HTML is a self-contained page with no JavaScript or remote assets and
includes a downloadable contact file. You can open it locally or host it
where you choose. CLI generation is entirely offline: it does **not** connect
to the database, start a server, publish `/card`, or send email. The `--generate`
flag is optional. Only `html` (default) and `vcard` formats are supported.

The JSON contract accepts `fullName` (required), `headline`, `bio`, `company`,
`role`, `location`, `email`, `phone`, and `links: [{"label": "...", "url": "https://..."}]`.
Other fields are rejected so a private contact record cannot accidentally be
exported wholesale. Optional fields may be omitted; blank strings stay blank.
Input is limited to 32 KiB, six links, a 2,000-character bio, and bounded
single-line fields. URLs must be absolute HTTP(S), without embedded credentials.

Both SQLite and Postgres receive the additive `profile_cards` migration on the
next CLI database open or web server startup. The web editor uses the web
app’s configured database; the offline `card` command never reads or changes
that database.

## Verify everything

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Database migrations

Migrations are applied automatically the first time the CLI or web server
opens the database, and re-running is always a no-op. To apply them as an
explicit step instead — recommended for any hosted deployment:

```bash
npm run db:migrate                                  # apply pending migrations
node apps/cli/dist/index.js migrate --status        # report without changing anything
```

Set `NETPRO_AUTO_MIGRATE=false` once you do this, so the server never runs
schema changes on a request path.

## Deploy

For Vercel, Docker Compose, managed Postgres, TLS modes, security headers, and
a production checklist, see **[deployment.md](deployment.md)**.

```bash
cp .env.example .env
# Edit .env — at minimum POSTGRES_PASSWORD, NEXTAUTH_SECRET, the GitHub OAuth
# credentials, NETPRO_OWNER_GITHUB_ID, and APP_URL.
docker compose build
docker compose up -d
curl http://localhost:3000/api/health
```

> SQLite is for local development and the CLI only. Any hosted deployment
> should use Postgres — on a serverless host the filesystem is ephemeral, so a
> SQLite database is lost on redeploy (NetPro refuses that configuration on
> Vercel rather than losing your data silently).
