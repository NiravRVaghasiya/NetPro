# Getting Started

## Prerequisites

- Node.js >= 20
- Docker (only needed for the Postgres/self-hosted path)

## Install

For normal use, install the published CLI globally:

```bash
npm install -g netpro
netpro --version
```

For repository development, install the workspace instead:

```bash
npm install
```

## Local-first quickstart (recommended)

No cloud account, no GitHub OAuth, no `DATABASE_URL`:

```bash
netpro init     # ~/.netpro: config.toml, identity, SQLite db, logs, keys
netpro serve    # NetPro at http://127.0.0.1:3777
```

When running from a source checkout, the equivalent commands are
`npm run build -w apps/cli` and `node apps/cli/dist/index.js <command>`.

`init` also writes this installation's identity (`[installation] id/created_at`)
and a `0600` access token at `~/.netpro/keys/access-token`. The identity is what
"you" are locally — no sign-in — and the token is only ever needed by callers
that are *not* on this machine (`netpro token` prints it).

`serve` prints the local server URL, applies pending migrations, and stays
in the foreground (`Ctrl+C` stops it). Check on everything with
`node apps/cli/dist/index.js status`. Import and search from another
terminal while it runs:

```bash
node apps/cli/dist/index.js import --linkedin ~/Downloads/Connections.csv
node apps/cli/dist/index.js search "product manager"
```

SQLite at `~/.netpro/netpro.db` is the default database. To use PostgreSQL
instead (Docker/teams/remote), set `[database] dialect/url` in
`~/.netpro/config.toml` — see [local-first.md](local-first.md) for the full
configuration reference.

## Run the web app (SQLite, local)

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev -w apps/web
```

Visit http://localhost:3000. The public card is unavailable until you explicitly
publish one. Private pages open straight into the workspace: requests from this
machine are the operator (see [Authentication modes](#authentication-modes)).

## Authentication modes

Local NetPro requires **no credentials at all**. `NETPRO_AUTH_MODE` decides who
is trusted:

| Mode | Who gets in |
| --- | --- |
| `local` (default) | Requests whose Host is loopback (`127.0.0.1`, `localhost`, `::1`) and that did not arrive through a proxy are the operator, identified by `~/.netpro/config.toml`. Everyone else needs GitHub sign-in (if configured) or their own front door. |
| `github` | Every caller signs in with GitHub. Selected automatically when `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are present, so existing deployments are unchanged. |
| `open` | NetPro authenticates nobody: only behind a reverse proxy, VPN, or private network that does. |

In `local` mode, bind/publish the Web UI to **127.0.0.1** — the trust decision
uses the Host header, so a public interface would let a caller claim to be
local. To expose it, use `github` or `open`. The full model is in
[phase-5-authentication.md](phase-5-authentication.md).

## Configure GitHub sign-in (optional)

GitHub OAuth is an optional integration rather than the application's identity
system: skip this entirely for local use. It is a **single-owner** instance when
you do configure it, not a multi-tenant service. Set these in
`apps/web/.env.local` (or the production server and Docker `.env`):

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

Set `NETPRO_AUTH_MODE=github` as well when you want GitHub sign-in to be the
only way in (for example on a public server). Auth.js v5's `AUTH_SECRET` /
`AUTH_URL` names are also supported. Behind a trusted reverse proxy, configure
its forwarded host/protocol correctly; set `AUTH_TRUST_HOST=true` only when that
proxy/host is trusted. Card writes enforce same-origin requests using those
headers.

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

The first run creates and migrates the local database
(`~/.netpro/netpro.db` — see [local-first.md](local-first.md)) automatically.
Re-importing the same file merges instead of duplicating.

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
node apps/cli/dist/index.js search acme engineer

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

### Better search: full-text and semantic (v2.0 Phase 4)

The search above is portable substring matching over six columns — it works
everywhere with zero setup, and it's still the default. Two stronger engines
stack on top of it.

**Full-text** (SQLite FTS5 / Postgres `tsvector`) needs no key and no network.
Build the index once, then ask for it:

```bash
node apps/cli/dist/index.js reindex            # build/refresh the index
node apps/cli/dist/index.js reindex --status   # coverage + what's enabled

node apps/cli/dist/index.js search "payments" --mode keyword
```

It searches the *whole* contact document — notes, tags, industry, seniority,
department, country — not just the six portable columns, and it does prefix
matching, so `stri` finds Stripe. Imports keep it current automatically.

**Semantic** adds an embedding arm and fuses the two ranked lists with
reciprocal rank fusion. It is opt-in, needs your own key, and needs Postgres
(SQLite has no vector support):

```bash
export EMBEDDINGS_PROVIDER=openai
export EMBEDDINGS_API_KEY=sk-...              # or: netpro config set embeddings.key sk-...
node apps/cli/dist/index.js reindex --embeddings

node apps/cli/dist/index.js search "someone who can introduce me to fintech" --semantic
```

Every result set explains itself:

```
Engine: keyword — full-text 1, substring 0
```

That line is the point of the feature — the contact was found by the full-text
arm and would have been missed by substring matching. The web app shows the
same thing as a "Results powered by …" badge, and its semantic toggle only
appears when the server has a key.

Nothing here changes behaviour until you opt in: no index → substring search,
no key → no semantic arm, embeddings API down → keyword results with a note
instead of an error.

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

## Find who has the skills you need (v2.0 Phase 5)

NetPro derives **skills** from what you already know about each contact —
headline, role, department, industry, tags, custom fields and notes — against
a fixed, explainable taxonomy (~100 skills across languages, frontend,
backend, mobile, cloud, data, AI, security, product, design, leadership and
business). Nothing is guessed: every skill points at the field and the words
that produced it. It runs offline; no key, no network.

```bash
netpro skills status                          # how many contacts have a stored verdict
netpro skills extract --dry-run               # preview what would be derived
netpro skills extract                         # derive + store (idempotent; reruns only write changes)
netpro skills "Ada Lovelace"                  # stored + current skills with evidence
netpro skills gap --role "Staff Data Engineer" --skills "python,k8s,airflow"
netpro skills gap --description "$(cat job.txt)"       # paste a job description
netpro skills gap --contact bob@data.dev --skills "python,dbt,kubernetes"
netpro search --skills "python,k8s"           # filter: every listed skill required
```

`skills gap` prints the required taxonomy skills it recognised (and the names
it ignored), per-skill coverage — who has each one, strongest tie first — the
skills **nobody** covers, and the best individual matches ranked by match
score then relationship. A match score counts a skill as *partial* when an
adjacent skill covers it (`kubernetes` via `docker`, `sql` via `postgresql`,
`typescript` via `javascript`), at half weight, and always says which rule
applied.

Extraction stores the **verdict** on the contact (`contacts.skills`) and the
**evidence** in `enrichments` (`provider = skills_heuristic | skills_ai`), so a
re-run can show what changed and why. Source fields are never modified. An
optional AI pass (`netpro skills extract --mode ai`) reuses the outreach
credentials and may only pick from the same taxonomy; if the model fails the
heuristic result still stands and the failure is reported. It is off unless
you ask for it.

The web app has **Skills** in the navigation (`/skills`): the target form,
the coverage table (each name links to the contact and to a warm-intro
search), the gaps, the ranked matches, a one-click **Derive skills** panel,
and — with no target — a map of what your network collectively knows. Skill
tags with their evidence appear on every contact page (a stored skill the
current text no longer supports is drawn dashed with a `?`). The same data is
available over the owner-only JSON APIs `GET /api/skills/gap?role=&description=&skills=[&contact=]`
and `POST /api/skills/extract` (`{ mode?, contact?, dryRun? }`).

## Events and who was there (v2.0 Phase 6)

Import a conference roster and NetPro matches it against your contacts, so a
contact list becomes "who I could see at this event" instead of a spreadsheet
you never open again.

```bash
netpro events import events.csv               # name, location, starts_at, attendees
netpro events list                            # every event + how many of yours went
netpro events list --query conf --upcoming
netpro events show "React Conf"               # id or exact name
netpro events add "React Conf" --location Berlin --starts 2026-09-14
netpro events link "React Conf" "Ada Lovelace" --role speaker
netpro events unlink "React Conf" "Ada Lovelace"
netpro events recommend                       # where to go next, with reasons
netpro events rm "React Conf"
```

Columns are matched by name, so `Event Name`, `starts_at` and `Attendee
Emails` all work; dates must be `YYYY-MM-DD` (an ambiguous `03/04/2026` is
rejected rather than guessed) and the attendee cell can be emails or names
separated by `,` `;` or `|`.

Matching runs in three tiers and always tells you which one fired: **exact
email** (1.0) and **exact name** (0.9) are linked; **last name + first
initial** (0.6) is reported for your approval and only linked with `--review`.
More than one plausible contact is `ambiguous` — you get the candidates and
pick, NetPro never guesses. Lines that match nobody are parked on the event,
so you can `netpro events match <event> --apply` after importing new contacts,
or link them by hand in the UI.

Two rules worth knowing:

- **An attendee list is evidence of attendance, not of a meeting.** The
  `met_at_event` edges an import creates are **pending** — confirm the ones
  you believe on `/edges`. A manual `netpro events link` is `confirmed`,
  because that is you speaking rather than an export file.
- Pairwise linking is capped at 250 edges per event per run; when a large
  event hits the cap the summary says so instead of quietly writing a
  fraction.

The web app has **Events** in the navigation (`/events`): the list with
network overlap, **Where to go next** (ranked 0.6 × people you know, 0.2 ×
industry fit, 0.2 × timing, each score explained), a CSV import panel that
previews before it writes, and `/events/<id>` for the attendee list, the
unmatched rows, and a re-check button. Each contact page now lists the events
you crossed paths at. The data is also available over the owner-only JSON
APIs `GET/POST /api/events`, `GET/DELETE /api/events/[id]`,
`POST /api/events/[id]/match` and `POST/DELETE /api/events/[id]/attendees`.

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

## Profile views (v2.5)

Your published card counts its visitors with a privacy-preserving beacon — no
cookies, no third parties, and no raw IP address ever stored (only a 16-hex
hash that rotates salt every UTC day, so it cannot be reversed or tracked
across days). Bots and your own views are labeled and excluded from the
numbers; `DNT: 1` / `Sec-GPC: 1` visitors are still counted but stored in
minimal mode. Raw view rows are kept for **90 days**, then purged by a daily
job.

See your numbers:

```bash
# From the CLI: summary, per-day bars, top referrers, recent views, known visitors
node apps/cli/dist/index.js card --views --days 30
node apps/cli/dist/index.js analyze --views      # the views section of the report
```

In the web app: the **Dashboard** renders a "Profile views" strip (totals,
sparkline, top referrers, recent views), and **Settings → Card** has the full
analytics tables (7/30/90-day windows, show/hide-bots). `GET /api/card/views`
is the owner-only API behind both.

Track where views come from:

1. **Embed the pixel** — copy the snippet from **Settings → Card → Tracking**
   (built from your instance's origin) and paste it before `</body>` on your
   blog or portfolio. It is one 1-pixel request, no JavaScript:

   ```html
   <img src="https://your-app.example.com/api/card/pixel.gif?p=blog" width="1" height="1" alt="">
   ```

2. **Share a signed link** — `https://your-app.example.com/card?v=…`
   (minted on **Settings → Card**) attributes visits to a specific contact in
   your "known visitors" list. Tokens are signed by your instance, expire
   after 30 days, and a link to an unknown or deleted contact is ignored.
   HTML cards can opt into the pixel with
   `card --generate --pixel-url https://your-app.example.com`.

Operator controls (server environment): `NETPRO_DISABLE_VIEWS=true` keeps the
beacons answering but stores nothing; `NETPRO_VIEW_SALT` sets the hash salt
(default: `NEXTAUTH_SECRET`). See [deployment.md](deployment.md) for details.

## Content tracker (v2.5)

Track what you publish and how each piece performs — one piece per normalized
URL, re-imports are idempotent, and snapshots are append-only (`null` means
"not reported", never zero).

```bash
node apps/cli/dist/index.js content list                 # newest-published first
node apps/cli/dist/index.js content list --platform blog --tag js --days 30

# Add one piece (idempotent on the URL)
node apps/cli/dist/index.js content add https://blog.example/my-post \
  --title "My post" --platform blog --type article --published-at 2026-08-01

# Bulk-import a CSV (url,title[,platform,type,published_at,author,tags]) or a feed
node apps/cli/dist/index.js content import posts.csv --dry-run   # preview first
node apps/cli/dist/index.js content import https://blog.example/feed.xml
# Any RSS 2.0 / Atom feed works; titles, dates and links are mapped for you.

# Record engagement (a snapshot, appended — never an update)
node apps/cli/dist/index.js content fetch my-post --manual --views 120 --likes 12

# Inspect one piece (detail + snapshot history) and get the library at a glance
node apps/cli/dist/index.js content show my-post --metrics
node apps/cli/dist/index.js content analyze --days 30
```

In the web app: the **Content** page (`/content`) lists and filters your
library with an "At a glance" overview; each piece (`/content/[id]`) shows
its snapshot history, the contacts it involves (mentions), and forms to
record numbers. The dashboard renders a "Content" strip, and contacts pages
list the content a person is part of.

**Providers:** v2.5 ships `manual` (always available) and `rss` (import)
built in. `devto`, `twitter`, and `github` are **disabled stubs** —
`content fetch` names the key that would enable each (`DEVTO_API_KEY`,
`TWITTER_BEARER_TOKEN`, `GITHUB_TOKEN`) and nothing calls any external API
until a provider is implemented. Engagement is recorded by you, at your
discretion.

## Verify everything

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Install a plugin from the marketplace

NetPro ships a plugin runtime (custom sources, enrichers, AI providers,
content providers, event discovery, commands) and a self-hosted marketplace —
a static index, no accounts, no telemetry. The reference entry is the example
event-discovery plugin:

```bash
# Browse the index (add a term to filter; --refresh bypasses the local cache)
netpro plugin search

# Install — checksum-verified, manifest-matched, and always disabled at first
netpro plugin install example-event-discovery

# Review the printed permissions, then enable
netpro plugin enable example-event-discovery --i-have-reviewed-permissions

# Later: monotonic updates (downgrades refused unless --force)
netpro plugin update example-event-discovery
```

Prefer the web UI? `/settings/plugins` (admin) has the same flow: browse the
marketplace, install, review the permissions dialog, enable. Plugin secrets
live in the encrypted vault (`/settings/keys`) as `plugin.<name>.<key>`. To
self-host the index or publish your own plugin, see
**[deployment.md](deployment.md#plugin-marketplace-v30-phase-6)** and
`marketplace/README.md`.

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

For any Node host, Docker Compose, managed Postgres, TLS modes, authentication
modes, security headers, and a production checklist, see
**[deployment.md](deployment.md)**.

```bash
npm run build && npm run db:migrate    # build once, migrate once, then start

# …or the containerised self-hosted path:
cp .env.example .env
# Edit .env — POSTGRES_PASSWORD and APP_URL are enough to run.
# Add NETPRO_AUTH_MODE=github + the GitHub variables for remote sign-in.
docker compose build
docker compose up -d
curl http://localhost:3000/api/health
```

> SQLite is the local default (and fine on a VPS or a container with a
> persistent volume), but it needs a filesystem that survives a restart: a
> deploy whose disk is per-instance should use Postgres. Set
> `NETPRO_SERVERLESS=1` when many short-lived instances share one database so
> each keeps a one-connection pool.
