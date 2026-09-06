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
node apps/cli/dist/index.js analyze --dormant --days 60 --limit 20

# Machine-readable output (the full overview payload)
node apps/cli/dist/index.js analyze --json
```

In the web app, the **Dashboard** page (`/dashboard`) renders the same numbers
from `GET /api/analytics`: metric cards, a 12-month growth chart, top
companies/industries, clusters, and your reconnect list.

> Analytics reads LinkedIn's "Connected On" date — imports record it as the
> contact's `createdAt` and initial `lastInteraction`, so growth reflects when
> relationships actually formed, not when the CSV was imported. Graph-native
> analytics (Louvain clusters, centrality, paths) arrive with the phase that
> populates the `edges` table; per-contact relationship scoring arrives with
> interaction logging (CRM).

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
**Settings** page shows which integrations are configured. Batch campaigns and
actual email delivery (SMTP) are planned for a later release.

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
