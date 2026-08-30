# NetPro — Open Source LinkedIn Premium Alternative

> **Mission:** Replicate and surpass LinkedIn Premium's networking features — free, self-hosted, and open source.

---

## 💡 Feature Ideas List

| # | Feature | LinkedIn Premium Version | Open Source Alternative |
|---|---------|------------------------|----------------------|
| 1 | **Smart Outreach** | InMail (limited monthly credits) | AI-composed emails via user's own SMTP + LLM API key |
| 2 | **Profile Viewers** | "Who viewed your profile" (last 90 days) | Self-hosted analytics pixel on portfolio/blog + referrer tracking |
| 3 | **Advanced People Search** | Boolean filters by role, company, location, industry | Federated search across GitHub, public APIs (People Data Labs, Hunter.io) |
| 4 | **Network Analytics** | Surface-level connection count & growth | Deep graph analysis on exported connections (centrality, clusters, dormant ties) |
| 5 | **Connection Insights** | Mutual connections, shared experiences | Enrichment engine: cross-reference GitHub, company data, shared repos/events |
| 6 | **Open Profile Beacon** | Make profile visible to non-connections | Personal "networking card" page (like cal.com link but for intros) |
| 7 | **AI Message Composer** | LinkedIn's AI-assisted messages | BYO-API-key LLM (OpenAI, Claude, Ollama) with context-aware templates |
| 8 | **Applicant Insights** | See how you compare to other applicants | Job posting analyzer: scrape public JDs, score your profile fit |
| 9 | **CRM / Relationship Tracker** | Basic "keep in touch" reminders | Full lightweight CRM: last contact, follow-up cadence, interaction log |
| 10 | **Warm Intro Pathfinder** | "Get introduced" via mutual connections | Graph traversal on your network to find shortest path to a target person |
| 11 | **Content Analytics** | Post impressions & engagement stats | Track engagement on cross-posted content (blog, Twitter/X, dev.to) |
| 12 | **Export & Portability** | Limited CSV export | Full data sovereignty: import/export in open formats (JSON, CSV, vCard) |
| 13 | **Batch Outreach Campaigns** | Not available (manual InMail only) | Drip campaign engine with personalization variables + scheduling |
| 14 | **Skills Gap Analyzer** | "Skills match" on job posts | Compare your profile against job requirements, suggest learning paths |
| 15 | **Event & Conference Matcher** | Not a Premium feature | Find relevant conferences/meetups and surface attendees in your network |

---

## 🏗️ Recommended Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Monorepo** | Turborepo + pnpm workspaces | Shared packages between CLI & web, fast builds |
| **Web Framework** | Next.js 14 (App Router) | Vercel-native, RSC for performance, API routes for serverless |
| **UI** | shadcn/ui + Tailwind CSS | Copy-paste components, no vendor lock-in, accessible |
| **CLI Framework** | `commander` + `ink` (React for CLI) | Cross-platform, rich TUI, shared React component logic |
| **Database** | SQLite (CLI local) / Supabase Postgres (web) | Zero-cost local mode; Supabase free tier for hosted |
| **ORM** | Drizzle ORM | Lightweight, type-safe, supports both SQLite & Postgres |
| **AI/LLM** | Vercel AI SDK + BYO key | Provider-agnostic (OpenAI, Anthropic, Ollama), streaming |
| **Auth** | NextAuth.js v5 (Auth.js) | OAuth via GitHub/Google, no LinkedIn dependency |
| **Email** | Resend / Nodemailer (BYO SMTP) | Outreach delivery, transactional notifications |
| **Search/Enrichment** | People Data Labs, Hunter.io, GitHub API | Professional data without scraping LinkedIn |
| **Graph Analysis** | `graphology` (JS) / NetworkX via WASM | Network visualization & pathfinding |
| **Analytics Pixel** | Custom 1x1 tracking endpoint | Profile viewer detection on user's own sites |
| **Queue/Jobs** | Inngest (serverless) or BullMQ (self-hosted) | Batch campaigns, scheduled follow-ups |
| **Deployment** | Vercel (web) / npm + brew (CLI) | Zero-config deploy; cross-platform CLI distribution |

### Data Sources (ToS-Compliant)

| Source | What It Provides | Cost |
|--------|-----------------|------|
| **LinkedIn Data Export** | User's own connections, messages, profile | Free (GDPR right) |
| **People Data Labs** | Professional profiles, enrichment | Free tier: 100 req/mo |
| **Hunter.io** | Email discovery, verification | Free tier: 25 req/mo |
| **GitHub API** | Developer profiles, repos, activity | Free: 5000 req/hr |
| **Clearbit (HubSpot)** | Company enrichment | Free tier available |
| **Google Custom Search** | Public profile discovery | Free: 100 queries/day |
| **OpenAI / Anthropic / Ollama** | Message generation, analysis | BYO key / free (local) |

---

## 📋 MVP Feature Set (v1.0)

### 🟢 Quick Wins — Ship in 4–6 weeks

| Feature | CLI Command | Web Equivalent |
|---------|------------|----------------|
| **Import Connections** | `netpro import --file connections.csv` | `/import` — drag-and-drop CSV uploader |
| **Network Analytics** | `netpro analyze --report terminal` | `/dashboard` — interactive graph + stats |
| **People Search** | `netpro search --role "SWE" --company "Stripe"` | `/search` — filterable table with facets |
| **AI Outreach** | `netpro outreach --to "jane@co.com" --tone warm` | `/outreach` — message composer with AI assist |
| **Export** | `netpro export --format csv --filter "engineers"` | `/dashboard` → Export button |
| **Profile Card** | `netpro card --generate` | `/card` — shareable networking page |

### CLI Commands (v1.0 Detail)

```bash
# Setup & Authentication
$ netpro init                          # Interactive setup wizard
$ netpro config set ai.provider openai # Configure AI provider
$ netpro config set ai.key sk-...      # Set API key (stored in OS keychain)

# Data Import
$ netpro import --linkedin connections.csv    # Import LinkedIn export
$ netpro import --github --username octocat   # Import from GitHub
$ netpro enrich --source hunter              # Enrich contacts with emails

# Search & Discovery
$ netpro search --role "Product Manager" --location "Berlin"
$ netpro search --company "Vercel" --open-to-connect
$ netpro search --skills "rust,wasm" --last-active 30d

# AI-Powered Outreach
$ netpro outreach --to "jane@example.com" --context "React Conf speaker"
$ netpro outreach --template cold-intro --batch ./targets.csv
$ netpro outreach --draft  # Opens in $EDITOR for review before send

# Analytics
$ netpro analyze --network-score         # Overall network health
$ netpro analyze --clusters              # Identify network clusters
$ netpro analyze --dormant --days 90     # Find stale connections
$ netpro analyze --path-to "John Smith"  # Shortest intro path

# CRM
$ netpro track add "Jane Doe" --met-at "React Conf" --follow-up 7d
$ netpro track list --due-today
$ netpro track log "Jane Doe" --note "Discussed collab on OSS project"

# Export & Portability
$ netpro export --format json --all
$ netpro export --format vcard --filter "company:Google"
```

### Web App Pages (v1.0 Detail)

```
/                  → Landing page (project info, quick start)
/dashboard         → Network overview: graph visualization, health score, growth chart
/search            → Advanced people search with real-time filters
/outreach          → AI message composer: context input → draft → send via email
/outreach/campaigns → Batch outreach with drip sequences
/import            → Multi-source importer: LinkedIn CSV, GitHub, manual
/contacts          → CRM view: all contacts, last interaction, follow-up dates
/contacts/[id]     → Individual contact: enriched profile, interaction history
/card              → Public networking card editor (like Linktree for intros)
/settings          → API keys, SMTP config, preferences
```

---

## 🗺️ Project Roadmap

| Version | Timeline | Features | Effort |
|---------|----------|----------|--------|
| **v0.1-alpha** | Week 1–2 | Monorepo scaffold, CLI skeleton, basic import/export | 1 dev, 2 weeks |
| **v1.0** | Week 3–8 | Import, Search, Analytics dashboard, AI outreach, Profile card | 1–2 devs, 6 weeks |
| **v1.5** | Week 9–12 | CRM tracking, Follow-up reminders, Batch campaigns | 1–2 devs, 4 weeks |
| **v2.0** | Month 4–6 | Warm intro pathfinder, Event matcher, Skills gap analyzer | 2–3 devs, 8 weeks |
| **v2.5** | Month 6–8 | Profile viewer analytics, Content cross-posting tracker | 2–3 devs, 6 weeks |
| **v3.0** | Month 9–12 | Plugin system, Self-hosted marketplace, Team features | 3+ devs, 12 weeks |

### Milestone Details

**v1.0 — "The Essentials"**
- LinkedIn CSV import with auto-enrichment
- Graph-based network analytics (cluster detection, centrality scoring)
- Federated people search (GitHub + People Data Labs + Hunter.io)
- AI-composed outreach with BYO API key
- Deployable to Vercel with one click

**v2.0 — "The Strategist"**
- Warm intro pathfinder (graph traversal: you → target via mutual nodes)
- Conference/event discovery with attendee matching
- Skills gap analysis against target roles
- Advanced CRM with interaction scoring

**v3.0 — "The Platform"**
- Plugin architecture (custom data sources, custom AI providers)
- Team/org mode (shared CRM, collaborative outreach)
- Self-hosted marketplace for community plugins
- Webhook integrations (Zapier, n8n, Make)

---

## 🚀 Suggested Repo Structure

```
netpro/
├── apps/
│   ├── web/                          # Next.js 14 web application
│   │   ├── app/
│   │   │   ├── (auth)/              # Auth routes (login, signup)
│   │   │   ├── (app)/               # Authenticated app routes
│   │   │   │   ├── dashboard/       # Network analytics
│   │   │   │   ├── search/          # People search
│   │   │   │   ├── outreach/        # Message composer
│   │   │   │   ├── contacts/        # CRM
│   │   │   │   ├── import/          # Data import
│   │   │   │   ├── card/            # Public profile card
│   │   │   │   └── settings/        # Configuration
│   │   │   ├── api/                 # API routes (serverless functions)
│   │   │   │   ├── search/
│   │   │   │   ├── enrich/
│   │   │   │   ├── outreach/
│   │   │   │   └── analytics/
│   │   │   └── layout.tsx
│   │   ├── components/              # UI components (shadcn/ui)
│   │   ├── lib/                     # Web-specific utilities
│   │   └── next.config.ts
│   │
│   └── cli/                          # CLI application
│       ├── src/
│       │   ├── commands/            # Command implementations
│       │   │   ├── init.ts
│       │   │   ├── import.ts
│       │   │   ├── search.ts
│       │   │   ├── outreach.ts
│       │   │   ├── analyze.ts
│       │   │   ├── track.ts
│       │   │   └── export.ts
│       │   ├── ui/                  # Ink (React CLI) components
│       │   │   ├── SearchResults.tsx
│       │   │   ├── AnalyticsDash.tsx
│       │   │   └── OutreachPreview.tsx
│       │   ├── config.ts            # CLI configuration manager
│       │   └── index.ts             # Entry point
│       ├── bin/
│       │   └── netpro.ts            # Binary entry
│       └── package.json
│
├── packages/
│   ├── core/                         # Shared business logic
│   │   ├── src/
│   │   │   ├── search/              # Search engine logic
│   │   │   ├── enrichment/          # Data enrichment pipeline
│   │   │   ├── analytics/           # Graph analysis algorithms
│   │   │   ├── ai/                  # LLM integration (provider-agnostic)
│   │   │   ├── crm/                 # Contact management logic
│   │   │   ├── import/              # Import parsers (CSV, JSON, vCard)
│   │   │   └── export/              # Export formatters
│   │   └── package.json
│   │
│   ├── db/                           # Database schema & migrations
│   │   ├── src/
│   │   │   ├── schema.ts            # Drizzle schema (works for SQLite + Postgres)
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   └── package.json
│   │
│   ├── ui/                           # Shared React components (web + CLI via Ink)
│   │   ├── src/
│   │   │   ├── NetworkGraph.tsx
│   │   │   ├── ContactCard.tsx
│   │   │   └── MessagePreview.tsx
│   │   └── package.json
│   │
│   └── config/                       # Shared configuration (ESLint, TSConfig, etc.)
│       ├── eslint/
│       ├── tsconfig/
│       └── tailwind/
│
├── plugins/                          # Official plugin examples
│   ├── plugin-github/               # GitHub data source
│   ├── plugin-hunter/               # Hunter.io enrichment
│   └── plugin-pdl/                  # People Data Labs
│
├── docs/                             # Documentation site (Nextra or Starlight)
│   ├── getting-started.mdx
│   ├── cli-reference.mdx
│   ├── self-hosting.mdx
│   └── api-reference.mdx
│
├── docker-compose.yml                # Self-hosted stack (Postgres + app)
├── turbo.json                        # Turborepo configuration
├── pnpm-workspace.yaml
├── LICENSE                           # MIT
└── README.md
```

---

## ⚡ Quick Start Concept

```markdown
# NetPro

> Your professional network, owned by you. Open source LinkedIn Premium alternative.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=...)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 🚀 Quick Start

### CLI (recommended for power users)

\```bash
# Install via npm
npm install -g @netpro/cli

# Or via Homebrew
brew install netpro

# Initialize your workspace
netpro init

# Import your LinkedIn connections
netpro import --linkedin ~/Downloads/Connections.csv

# See your network analytics
netpro analyze --network-score

# Search for people to connect with
netpro search --role "Engineering Manager" --location "Berlin"

# Generate an outreach message
netpro outreach --to "jane@company.com" --context "spoke at ReactConf"
\```

### Web App (one-click deploy)

\```bash
# Clone and deploy
git clone https://github.com/netpro/netpro.git
cd netpro

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env.local
# Add your API keys (OpenAI, Hunter.io, etc.)

# Run locally
pnpm dev

# Or deploy to Vercel
vercel deploy
\```

### Self-Hosted (Docker)

\```bash
docker compose up -d
# App available at http://localhost:3000
\```

## ⚙️ Configuration

NetPro uses a bring-your-own-key model. Add only the services you want:

\```bash
netpro config set ai.provider openai      # or anthropic, ollama
netpro config set ai.key sk-...
netpro config set enrichment.hunter YOUR_HUNTER_KEY
netpro config set enrichment.pdl YOUR_PDL_KEY
netpro config set email.smtp smtp://...
\```

## 📊 Features

| Feature | CLI | Web | Status |
|---------|-----|-----|--------|
| Import LinkedIn data | ✅ | ✅ | Stable |
| Network analytics | ✅ | ✅ | Stable |
| People search | ✅ | ✅ | Stable |
| AI outreach | ✅ | ✅ | Stable |
| CRM tracking | ✅ | ✅ | Beta |
| Profile card | — | ✅ | Beta |
| Warm intro path | ✅ | ✅ | Alpha |
| Batch campaigns | ✅ | ✅ | Alpha |
```

---

## 💰 Monetization & Sustainability

### Open Core Model (Recommended)

| Tier | Price | What's Included |
|------|-------|-----------------|
| **Community** | Free forever | Full CLI + self-hosted web app, all core features |
| **Cloud** | $9/mo | Hosted version, managed DB, no setup required |
| **Pro** | $29/mo | Priority enrichment API, higher rate limits, team features |
| **Enterprise** | Custom | SSO, audit logs, dedicated support, SLA |

### Revenue Streams

1. **Hosted SaaS** — Managed deployment for non-technical users ($9–29/mo)
2. **Premium Plugins** — Advanced plugins in a marketplace (rev share with authors)
3. **API Metering** — Hosted enrichment/search API with usage-based pricing
4. **GitHub Sponsors** — Community funding for OSS maintenance
5. **Consulting** — Custom integrations for teams/companies
6. **Affiliate Revenue** — Referral fees from data providers (Hunter, PDL)

### Sustainability Principles

- Core remains MIT-licensed, always
- Self-hosted = full feature parity with Cloud tier
- Revenue funds full-time maintainership (target: 2 FTE by Year 2)
- Community contributions rewarded via bounty program

---

## 🏛️ Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACES                          │
├────────────────────────────┬────────────────────────────────────┤
│      CLI (commander/ink)   │       Web App (Next.js 14)         │
│  ┌──────────────────────┐  │  ┌──────────────────────────────┐  │
│  │ $ netpro search ...  │  │  │  /search  /dashboard  /crm   │  │
│  │ $ netpro outreach .. │  │  │  React + shadcn/ui + D3.js   │  │
│  └──────────┬───────────┘  │  └──────────────┬───────────────┘  │
├─────────────┼──────────────┴─────────────────┼──────────────────┤
│             │         SHARED CORE            │                  │
│             └───────────┬────────────────────┘                  │
│  ┌──────────────────────┼──────────────────────────────────┐    │
│  │                @netpro/core                              │    │
│  │  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐   │    │
│  │  │ Search  │ │ Enrich   │ │   AI   │ │  Analytics  │   │    │
│  │  │ Engine  │ │ Pipeline │ │ Router │ │   Engine    │   │    │
│  │  └────┬────┘ └────┬─────┘ └───┬────┘ └──────┬──────┘   │    │
│  └───────┼───────────┼───────────┼─────────────┼──────────┘    │
├──────────┼───────────┼───────────┼─────────────┼───────────────┤
│          │      DATA & SERVICES  │             │               │
│  ┌───────▼───────┐ ┌─────▼──────▼──┐  ┌───────▼──────────┐    │
│  │  External APIs │ │  LLM Providers │  │   Database       │    │
│  │  • Hunter.io   │ │  • OpenAI      │  │  • SQLite (CLI)  │    │
│  │  • PDL         │ │  • Anthropic   │  │  • Supabase (web)│    │
│  │  • GitHub      │ │  • Ollama      │  │  • Drizzle ORM   │    │
│  │  • Clearbit    │ │  • Groq        │  │                  │    │
│  └───────────────┘ └────────────────┘  └──────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔒 Privacy & Compliance Design

| Principle | Implementation |
|-----------|---------------|
| **Data minimization** | Only store what user explicitly imports or creates |
| **No silent scraping** | All data from user-consented sources (their own export, public APIs) |
| **Encryption at rest** | SQLite encrypted via SQLCipher; Supabase RLS policies |
| **BYO keys** | API keys stored in OS keychain (CLI) or encrypted env vars (web) |
| **GDPR-ready** | One-click data export/deletion in all formats |
| **Audit log** | Every enrichment/outreach action logged locally |
| **Opt-in analytics** | Telemetry off by default, anonymous if enabled |

---

## 🧩 Plugin Architecture (v3.0)

```typescript
// plugins/plugin-github/index.ts
import { definePlugin } from '@netpro/core';

export default definePlugin({
  name: 'github',
  version: '1.0.0',
  
  // Register data source
  sources: [{
    id: 'github-profiles',
    search: async (query, opts) => {
      const users = await octokit.search.users({ q: query });
      return users.map(toNetProContact);
    }
  }],
  
  // Register enrichment provider
  enrichers: [{
    id: 'github-activity',
    enrich: async (contact) => {
      const repos = await octokit.repos.listForUser({ username: contact.github });
      return { languages: extractLangs(repos), activity_score: calcScore(repos) };
    }
  }],
  
  // Register CLI commands
  commands: [{
    name: 'github:import',
    description: 'Import connections from GitHub followers/following',
    handler: async (args) => { /* ... */ }
  }]
});
```

---

## 🎯 Competitive Positioning

| Dimension | LinkedIn Premium | NetPro |
|-----------|-----------------|--------|
| **Cost** | $60–180/mo | Free (self-hosted) or $9/mo (cloud) |
| **Data ownership** | LinkedIn owns your graph | You own everything |
| **AI provider** | LinkedIn's model only | Any LLM (OpenAI, Claude, Ollama local) |
| **Outreach** | InMail (5–50/mo, platform-locked) | Unlimited via your own email |
| **Customization** | None | Full plugin system, open source |
| **Export** | Limited CSV | Full JSON, CSV, vCard, PDF |
| **Privacy** | Tracked, profiled, sold | Zero tracking, local-first option |
| **Search** | LinkedIn members only | Federated across GitHub, web, APIs |
| **Automation** | None | Full CLI scripting, cron-friendly |

---

## 📐 Database Schema (Simplified)

```sql
-- Core entities
CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT,
  company       TEXT,
  role          TEXT,
  location      TEXT,
  linkedin_url  TEXT,
  github_url    TEXT,
  avatar_url    TEXT,
  tags          TEXT,  -- JSON array
  source        TEXT,  -- 'linkedin_import', 'github', 'manual'
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE interactions (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT REFERENCES contacts(id),
  type        TEXT,  -- 'email_sent', 'meeting', 'note', 'follow_up'
  content     TEXT,
  metadata    TEXT,  -- JSON
  occurred_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT DEFAULT 'draft',  -- draft, active, paused, completed
  template    TEXT,
  config      TEXT,  -- JSON: schedule, personalization vars
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE campaign_recipients (
  campaign_id TEXT REFERENCES campaigns(id),
  contact_id  TEXT REFERENCES contacts(id),
  status      TEXT DEFAULT 'pending',  -- pending, sent, opened, replied
  sent_at     DATETIME,
  opened_at   DATETIME,
  replied_at  DATETIME
);

CREATE TABLE network_graph (
  source_id   TEXT REFERENCES contacts(id),
  target_id   TEXT REFERENCES contacts(id),
  relation    TEXT,  -- 'connection', 'colleague', 'met_at_event'
  strength    REAL DEFAULT 0.5,
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE enrichments (
  contact_id  TEXT REFERENCES contacts(id),
  provider    TEXT,  -- 'hunter', 'pdl', 'github', 'clearbit'
  data        TEXT,  -- JSON payload
  fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🧪 Key Technical Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Monorepo tool | Turborepo | Faster than Nx for JS-only, Vercel-aligned |
| Package manager | pnpm | Strict deps, fast installs, workspace-native |
| TypeScript | Strict mode | Shared types between CLI & web reduce bugs |
| AI abstraction | Vercel AI SDK | Provider-agnostic, streaming, edge-compatible |
| Graph viz | D3.js + force-graph | Most flexible, no heavy dependency |
| CLI UI | Ink (React) | Share component logic with web app |
| Testing | Vitest + Playwright | Fast unit tests + E2E for web |
| CI/CD | GitHub Actions | Free for OSS, Vercel auto-deploy |
| Docs | Fumadocs or Starlight | MDX-native, searchable, Vercel-deployable |
| License | MIT | Maximum adoption, permissive for enterprise use |

---

*Built with ❤️ by the open source community. Your network, your data, your rules.*
