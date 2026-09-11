# Getting Started

## Prerequisites

- Node.js >= 20
- Docker (only needed for the Postgres/self-hosted path)

## Install

For normal use, install the CLI globally from the release bundle:

```bash
npm install -g https://github.com/NiravRVaghasiya/NetPro/releases/download/v3.0.1/netpro-3.0.1.tgz
netpro --version      # 3.0.1
```

> The unscoped npm name `netpro` belongs to an unrelated package, so NetPro is
> not published to the npm registry and `npm install -g netpro` does not install
> this project. Each [release](https://github.com/NiravRVaghasiya/NetPro/releases)
> attaches an installable `netpro-<version>.tgz` (checksummed in `SHA256SUMS`)
> that installs the same CLI with its bundled server, migrations and native
> drivers. See [releasing.md](releasing.md).

For repository development, install the workspace instead:

```bash
npm install
```

### When `netpro` is not recognized after installing

The install succeeded; the command is not on `PATH`. `npm install -g` writes its
shims into npm's **global prefix** — `%AppData%\npm` on Windows,
`/usr/local/bin` or a version-manager directory elsewhere — and that directory is
what has to be on `PATH`. Node installed by a package manager (Scoop, nvm,
Volta, fnm) does not always put it there.

```powershell
npm config get prefix        # where the shims went
dir "$env:AppData\npm\netpro*"   # netpro.cmd / netpro.ps1 / netpro should exist
where netpro                 # does the shell find one?
```

- If `netpro.cmd` exists but `where netpro` prints nothing, add the prefix from
  `npm config get prefix` to your user `PATH` (System Properties → Environment
  Variables → *User variables* → `Path` → New) and open a **new** terminal.
- To run it without touching `PATH`: `"%AppData%\npm\netpro.cmd" init`.

Two npm behaviours make this look like NetPro's fault. Neither is:

- **`npm install -g` with no package name installs the *current project*
  globally.** Run from a checkout of this repository, it replaces the globally
  installed `netpro` with a link to the working tree and prunes the release
  bundle's dependencies — output like `removed 52 packages, and changed 1
  package` — which reads like the install deleting itself. Pass the package
  (`npm install -g <tarball-url>`) or run it from a neutral directory.
- **`npm warn allow-scripts … not yet covered by allowScripts` is advisory.**
  With npm 11.17 the install script still runs unless `--strict-allow-scripts` is
  set, so the warning does not mean `better-sqlite3` was skipped. A package's own
  `allowScripts` field is not consulted for global installs, which is why it
  appears even when the manifest lists the package. To silence it, use
  `npm config set allow-scripts=better-sqlite3 --location=user`.

Running from a source checkout needs no global install at all — see below.

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

Visit http://localhost:3000. The Web UI is a pure client of the standalone
server (Phase 24): requests from this machine reach the server as the operator
(see [Authentication modes](#authentication-modes)). Start the server first —
`netpro serve` — and the Observatory, Network, People, Search, Pathfinder,
Activity, Scan, Import, and Settings pages all render from it.

## Authentication modes

Local NetPro requires **no credentials at all**. `NETPRO_AUTH_MODE` on the
**server** decides who is trusted (the Web UI performs no authentication of its
own since Phase 24):

| Mode | Who gets in |
| --- | --- |
| `local` (default) | Requests whose socket peer is loopback (`127.0.0.1`, `localhost`, `::1`) and that did not arrive through a proxy are the operator, identified by `~/.netpro/config.toml`. Everyone else needs the access token (`netpro token`). |
| `token` | Every caller, loopback included, presents the access token (`Authorization: Bearer <token>`). |
| `open` | NetPro authenticates nobody: only behind a reverse proxy, VPN, or private network that does. |

To expose a server beyond loopback, use `token` (or `open` behind your own
auth). To expose the Web UI itself, put your own auth/TLS reverse proxy in
front of port 3000 — it has no sign-in of its own. The full model is in
[local-first.md](local-first.md).

## Run the CLI

```bash
npm run build -w apps/cli
node apps/cli/dist/index.js --help
```

## Import your connections

```bash
node apps/cli/dist/index.js import --linkedin ~/Downloads/Connections.csv
```

Adding one person, not a whole export? Open **People → + Add Person** in the
web UI and paste their LinkedIn profile URL
(`https://www.linkedin.com/in/username`). NetPro validates the URL, skips the
add when the profile is already in your network (pointing at the existing
contact instead of duplicating), and creates the person otherwise. The same
single-profile add is embedded in the **Import** page.

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
(not an error). Give the server a key either as a server-side environment
variable (`HUNTER_API_KEY`/`PDL_API_KEY`/`CLEARBIT_API_KEY`, see
`apps/web/.env.example`) or in the web UI under **Settings → Connect an API**,
which verifies the key where the provider allows a safe check and then stores
it encrypted (AES-256-GCM) on the server. UI storage needs
`ENCRYPTION_MASTER_KEY` (at least 32 characters) set on the process running
`netpro serve`; without it, key management is read-only and environment keys
keep working. Stored keys are never shown again — only the last four
characters — and can be tested, replaced, or removed from the same card.

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

The **Observatory** page renders the same numbers from `GET /api/analytics`:
metric cards, a 12-month growth chart, top companies/industries, clusters, and
your reconnect list. The **Network** page shows the graph section (Louvain
communities, centrality, components, and warm-intro candidates over your
confirmed edges; `pending` candidates stay out until you confirm them), and
**Pathfinder** turns candidates into actual intro plans (see below). The legacy
`/dashboard` and `/graph` pages were removed in Phase 24; these are their
server-backed successors.

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

Edge management is CLI-first (the `/edges` page was removed in Phase 24);
the **Network** and **People** pages visualize the graph the CLI maintains.

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

The **Pathfinder** page (`/pathfinder`) is the web surface for this: a target
picker (search the contact list or type any name/email/id), the ranked chain
cards, and a **First ask** on each path (the `/graph` page and its
`/api/graph/overview` + `/api/graph/paths` routes were removed in Phase 24; the
standalone server serves `GET /api/graph`, `GET /api/graph/path`, and
`GET /api/graph/visualization`, and the page caps depth at 6 while the CLI
accepts the engine's full 1–8).

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

The `/skills` page and its `/api/skills/*` routes were removed in Phase 24 —
skills are now CLI-first (`netpro skills …` above). Skill tags still surface
on the **Search** results and **People** pages, which the standalone server
feeds.

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
  you believe with `netpro edge confirm`. A manual `netpro events link` is
  `confirmed`, because that is you speaking rather than an export file.
- Pairwise linking is capped at 250 edges per event per run; when a large
  event hits the cap the summary says so instead of quietly writing a
  fraction.

The `/events` page and its `/api/events/*` routes were removed in Phase 24 —
events are CLI-first (`netpro events …` above).

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

The `/outreach` page was removed in Phase 24 — drafting is CLI-first
(`netpro outreach` above). Configure the server with `AI_PROVIDER`,
`OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`), optionally `OPENAI_BASE_URL` for an
OpenAI-compatible endpoint, and `OPENAI_MODEL`/`ANTHROPIC_MODEL` overrides — or
paste the key in the web UI under **Settings → Connect an API** (stored
encrypted, verified with the provider before saving); the **Settings** page
shows which integrations are configured either way.

## Track relationships & follow-ups

NetPro v1.5 keeps a per-contact interaction history — email, meetings, calls,
notes, LinkedIn messages, intros — with a computed relationship score, plus
follow-up reminders with due-today/overdue/upcoming views. The web CRM lives at
**People** in the navigation (`/people`, `/people/[id]` — the read-only
Phase 24 successors of `/contacts`); from the terminal, `netpro track` speaks
the same language:

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
Campaigns are CLI-first since Phase 24 (the `/outreach/campaigns` pages were
removed); the CLI commands:

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

Phase 24 removed the `/settings/card` editor and the public `/card` page from
the Web UI, so the profile card is now generated from the CLI (portable HTML +
vCard). Use the fictional example in
[`docs/examples/profile.json`](examples/profile.json) as the JSON source and
replace its details (see the CLI section below).

Every filled field on a generated card is public, including email/phone and
contact downloads, so treat the generated file like any other public asset —
`noindex` is **not** access control, and republishing cannot revoke copies
someone has already downloaded, cached independently, or screenshotted.

### Portable HTML and vCard (CLI)

Copy the fictional example in
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
next CLI database open or server startup. The offline `card` command never
reads or changes the database; the server no longer exposes the old `/card`
routes (removed in Phase 24).

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

The view-tracking *beacons* (`/api/card/pixel.gif`, `/api/card/view`) and the
`/card` page lived in the old Web UI and were removed in Phase 24. View
analytics remain a CLI-first feature (`netpro card --views`, `netpro analyze
--views`); HTML cards can still embed a pixel if you host the beacon yourself
(`card --generate --pixel-url https://your-app.example.com`). Operator
controls (server environment): `NETPRO_DISABLE_VIEWS=true` keeps beacons
answering but stores nothing; `NETPRO_VIEW_SALT` sets the hash salt (default
falls back to a built-in constant). See
[deployment.md](deployment.md) for details.

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

The `/content` page and its `/api/content/*` routes were removed in Phase 24 —
content tracking is CLI-first (`netpro content …` above).

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

Plugins are CLI-first since Phase 24 (the `/settings/plugins` and
`/settings/keys` pages were removed); plugin secrets live in the encrypted
vault as `plugin.<name>.<key>`. To self-host the index or publish your own
plugin, see
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
# Edit .env — POSTGRES_PASSWORD is enough to run locally.
docker compose build
docker compose up -d
curl http://localhost:3000/            # Web UI (pure client)
curl http://localhost:3777/api/health  # standalone NetPro API
```

> SQLite is the local default (and fine on a VPS or a container with a
> persistent volume), but it needs a filesystem that survives a restart: a
> deploy whose disk is per-instance should use Postgres. Set
> `NETPRO_SERVERLESS=1` when many short-lived instances share one database so
> each keeps a one-connection pool.
