# NetPro — DevOps & Deployment Pipeline

> CI/CD workflows, testing strategy, Vercel/Netlify deploy configs, Docker self-hosting, release management, and monitoring — everything needed to ship and operate NetPro reliably.

---

## Part 1: CI/CD Pipeline (GitHub Actions)

---

### 1.1 Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CI/CD PIPELINE                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Push / PR                                                                  │
│     │                                                                       │
│     ▼                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ STAGE 1: VALIDATE (parallel, ~2 min)                                │   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │   │
│  │ │  Lint    │ │TypeCheck │ │  Format  │ │ Lockfile │ │  Audit    │  │   │
│  │ │(ESLint) │ │  (tsc)   │ │(Prettier)│ │  Check   │ │(npm audit)│  │   │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └───────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│     │                                                                       │
│     ▼                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ STAGE 2: TEST (parallel, ~5 min)                                    │   │
│  │ ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐    │   │
│  │ │ Unit Tests     │ │ Integration    │ │ E2E (Playwright)       │    │   │
│  │ │ (Vitest)       │ │ Tests (Vitest) │ │ [web app only]         │    │   │
│  │ │ packages/*     │ │ API routes     │ │ Critical user flows    │    │   │
│  │ └────────────────┘ └────────────────┘ └────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│     │                                                                       │
│     ▼                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ STAGE 3: BUILD (parallel, ~3 min)                                   │   │
│  │ ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐    │   │
│  │ │ Web App Build  │ │ CLI Build      │ │ Docker Image           │    │   │
│  │ │ (Next.js)      │ │ (tsup bundle)  │ │ (multi-arch)           │    │   │
│  │ └────────────────┘ └────────────────┘ └────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│     │                                                                       │
│     ▼ (main branch only)                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ STAGE 4: DEPLOY                                                     │   │
│  │ ┌────────────────┐ ┌────────────────┐ ┌────────────────────────┐    │   │
│  │ │ Vercel Preview │ │ npm Publish    │ │ Docker Push            │    │   │
│  │ │ (PR) / Prod    │ │ (tag release)  │ │ (ghcr.io)             │    │   │
│  │ │ (main merge)   │ │               │ │                        │    │   │
│  │ └────────────────┘ └────────────────┘ └────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 Main CI Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '20'
  PNPM_VERSION: '9'
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}

jobs:
  # ═══════════════════════════════════════════
  # STAGE 1: Validate
  # ═══════════════════════════════════════════
  validate:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Turbo Cache
        uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: turbo-${{ runner.os }}-
      
      - name: Lint
        run: pnpm turbo lint
      
      - name: Type Check
        run: pnpm turbo typecheck
      
      - name: Format Check
        run: pnpm prettier --check "**/*.{ts,tsx,md,json}"
      
      - name: Security Audit
        run: pnpm audit --audit-level=high
        continue-on-error: true  # Don't block on moderate

  # ═══════════════════════════════════════════
  # STAGE 2: Test
  # ═══════════════════════════════════════════
  test-unit:
    name: Unit & Integration Tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: validate
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Run Unit Tests
        run: pnpm turbo test -- --coverage
      
      - name: Upload Coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./packages/*/coverage/lcov.info,./apps/*/coverage/lcov.info
          token: ${{ secrets.CODECOV_TOKEN }}

  test-e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: validate
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Install Playwright
        run: pnpm --filter @netpro/web exec playwright install --with-deps chromium
      
      - name: Build Web App
        run: pnpm turbo build --filter=@netpro/web
        env:
          DATABASE_URL: "file:./test.db"
          NEXTAUTH_SECRET: "test-secret-do-not-use-in-production"
          NEXTAUTH_URL: "http://localhost:3000"
      
      - name: Run E2E Tests
        run: pnpm --filter @netpro/web test:e2e
        env:
          DATABASE_URL: "file:./test.db"
          NEXTAUTH_SECRET: "test-secret-do-not-use-in-production"
      
      - name: Upload Test Artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: apps/web/playwright-report/
          retention-days: 7

  # ═══════════════════════════════════════════
  # STAGE 3: Build
  # ═══════════════════════════════════════════
  build-web:
    name: Build Web App
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [test-unit, test-e2e]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Build
        run: pnpm turbo build --filter=@netpro/web
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          NEXTAUTH_SECRET: ${{ secrets.NEXTAUTH_SECRET }}
      
      - name: Check Bundle Size
        run: |
          npx @next/bundle-analyzer analyze apps/web/.next
          # Fail if JS bundle exceeds 200KB (first-load)
        continue-on-error: true

  build-cli:
    name: Build CLI
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [test-unit]
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Build CLI
        run: pnpm turbo build --filter=@netpro/cli
      
      - name: Test CLI Binary
        run: |
          node apps/cli/dist/index.js --version
          node apps/cli/dist/index.js --help

  # ═══════════════════════════════════════════
  # STAGE 4: Docker
  # ═══════════════════════════════════════════
  build-docker:
    name: Build Docker Image
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: [test-unit, test-e2e]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Build and Push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

### 1.3 Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  packages: write
  id-token: write  # npm provenance

jobs:
  release-cli:
    name: Publish CLI to npm
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: '9'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo build --filter=@netpro/cli
      
      - name: Publish to npm
        run: pnpm --filter @netpro/cli publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  release-docker:
    name: Publish Docker Image (Tagged)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Extract version
        id: version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
      
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ghcr.io/${{ github.repository }}:${{ steps.version.outputs.VERSION }}
            ghcr.io/${{ github.repository }}:latest

  release-github:
    name: GitHub Release
    runs-on: ubuntu-latest
    needs: [release-cli, release-docker]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Generate Changelog
        id: changelog
        run: |
          # Get commits since last tag
          PREV_TAG=$(git tag --sort=-v:refname | sed -n '2p')
          echo "CHANGELOG<<EOF" >> $GITHUB_OUTPUT
          git log --pretty=format:"- %s (%h)" ${PREV_TAG}..HEAD >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT
      
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          body: |
            ## What's Changed
            ${{ steps.changelog.outputs.CHANGELOG }}
            
            ## Install
            ```bash
            npm install -g @netpro/cli@${{ github.ref_name }}
            # or
            docker pull ghcr.io/${{ github.repository }}:${GITHUB_REF#refs/tags/v}
            ```
          generate_release_notes: true
```

---

## Part 2: Testing Strategy

---

### 2.1 Test Pyramid

```
                    ╱╲
                   ╱  ╲          E2E Tests (Playwright)
                  ╱ 10 ╲         • Critical user flows
                 ╱──────╲        • Deploy preview testing
                ╱        ╲
               ╱ Integr.  ╲      Integration Tests (Vitest)
              ╱    30      ╲     • API routes, DB queries
             ╱──────────────╲    • Enrichment pipeline
            ╱                ╲
           ╱   Unit Tests     ╲   Unit Tests (Vitest)
          ╱       60           ╲  • Pure functions, utils
         ╱──────────────────────╲ • Schema validation
        ╱                        ╲• Algorithms (scoring, graph)
       ╱──────────────────────────╲

Target coverage: 80% (core packages), 60% (apps)
```

---

### 2.2 Test Configuration

```typescript
// vitest.config.ts (root)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
      thresholds: {
        branches: 70,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
});
```

---

### 2.3 Test Examples

```typescript
// packages/core/src/import/__tests__/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeTitle, generateFingerprint, mergeContacts } from '../normalize';

describe('normalizeTitle', () => {
  it('extracts seniority from title', () => {
    expect(normalizeTitle('Senior Software Engineer')).toEqual({
      role: 'Software Engineer',
      seniority: 'senior',
    });
  });

  it('handles VP-level titles', () => {
    expect(normalizeTitle('VP of Engineering')).toEqual({
      role: 'of Engineering',
      seniority: 'vp',
    });
  });

  it('defaults to mid seniority', () => {
    expect(normalizeTitle('Product Manager')).toEqual({
      role: 'Product Manager',
      seniority: 'mid',
    });
  });

  it('handles empty input', () => {
    expect(normalizeTitle(undefined)).toEqual({});
  });
});

describe('generateFingerprint', () => {
  it('prioritizes email', () => {
    expect(generateFingerprint({ email: 'Jane@Example.COM', fullName: 'Jane Doe' }))
      .toBe('email:jane@example.com');
  });

  it('falls back to name+company', () => {
    expect(generateFingerprint({ fullName: 'Jane Doe', company: 'Stripe' }))
      .toBe('name:janedoe|company:stripe');
  });
});

describe('mergeContacts', () => {
  it('prefers non-null incoming values', () => {
    const existing = { fullName: 'Jane', email: 'jane@old.com', company: null };
    const incoming = { fullName: 'Jane Doe', email: null, company: 'Stripe' };
    
    const merged = mergeContacts(existing, incoming);
    expect(merged.fullName).toBe('Jane Doe');    // Updated
    expect(merged.email).toBe('jane@old.com');   // Kept
    expect(merged.company).toBe('Stripe');       // Filled
  });
});
```

```typescript
// packages/core/src/analytics/__tests__/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { computeRelationshipScore } from '../scoring';

describe('computeRelationshipScore', () => {
  it('returns 0 with no interactions', () => {
    const score = computeRelationshipScore(mockContact, []);
    expect(score).toBe(0);
  });

  it('scores high for recent frequent bidirectional interactions', () => {
    const interactions = [
      mockInteraction({ direction: 'outbound', occurredAt: daysAgo(1) }),
      mockInteraction({ direction: 'inbound', occurredAt: daysAgo(3) }),
      mockInteraction({ direction: 'outbound', occurredAt: daysAgo(7), type: 'meeting' }),
      mockInteraction({ direction: 'inbound', occurredAt: daysAgo(14), type: 'email_received' }),
    ];
    
    const score = computeRelationshipScore(mockContact, interactions);
    expect(score).toBeGreaterThan(70);
  });

  it('scores low for old one-directional interactions', () => {
    const interactions = [
      mockInteraction({ direction: 'outbound', occurredAt: daysAgo(120) }),
    ];
    
    const score = computeRelationshipScore(mockContact, interactions);
    expect(score).toBeLessThan(30);
  });

  it('never exceeds 100', () => {
    const manyInteractions = Array(50).fill(null).map((_, i) =>
      mockInteraction({ direction: i % 2 ? 'inbound' : 'outbound', occurredAt: daysAgo(i) })
    );
    
    const score = computeRelationshipScore(mockContact, manyInteractions);
    expect(score).toBeLessThanOrEqual(100);
  });
});
```

```typescript
// apps/web/tests/e2e/import.spec.ts
import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('LinkedIn Import Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Login via test account
    await page.goto('/login');
    await page.click('[data-testid="login-github"]');
    // Mock OAuth with Playwright's route interception
  });

  test('imports CSV and shows contacts on dashboard', async ({ page }) => {
    await page.goto('/import');
    
    // Upload CSV
    const csvPath = path.join(__dirname, 'fixtures', 'linkedin-export-sample.csv');
    await page.setInputFiles('input[type="file"]', csvPath);
    
    // Wait for processing
    await expect(page.getByText('Processing...')).toBeVisible();
    await expect(page.getByText(/Imported \d+ contacts/)).toBeVisible({ timeout: 10000 });
    
    // Navigate to dashboard
    await page.goto('/dashboard');
    
    // Verify contacts appear
    await expect(page.getByTestId('total-contacts')).not.toHaveText('0');
    await expect(page.getByTestId('network-graph')).toBeVisible();
  });

  test('deduplicates on re-import', async ({ page }) => {
    await page.goto('/import');
    
    // Import same file twice
    const csvPath = path.join(__dirname, 'fixtures', 'linkedin-export-sample.csv');
    await page.setInputFiles('input[type="file"]', csvPath);
    await expect(page.getByText(/Imported \d+ contacts/)).toBeVisible({ timeout: 10000 });
    
    const firstCount = await page.getByTestId('import-count').textContent();
    
    // Re-import
    await page.setInputFiles('input[type="file"]', csvPath);
    await expect(page.getByText(/merged/i)).toBeVisible({ timeout: 10000 });
    
    // Count shouldn't double
    await page.goto('/dashboard');
    const total = await page.getByTestId('total-contacts').textContent();
    expect(Number(total)).toBe(Number(firstCount));
  });
});
```

---

### 2.4 CLI Testing

```typescript
// apps/cli/src/__tests__/commands/search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { createTestDB, seedTestContacts } from '../helpers/test-db';

describe('netpro search', () => {
  beforeEach(async () => {
    // Setup test database with seed data
    await createTestDB();
    await seedTestContacts([
      { fullName: 'Jane Smith', role: 'Product Manager', company: 'Stripe', location: 'SF' },
      { fullName: 'John Doe', role: 'Engineer', company: 'Google', location: 'NYC' },
      { fullName: 'Alice Zhang', role: 'Senior PM', company: 'Stripe', location: 'SF' },
    ]);
  });

  it('searches by role', () => {
    const output = execSync('node dist/index.js search --role "Product Manager"').toString();
    expect(output).toContain('Jane Smith');
    expect(output).toContain('Alice Zhang'); // "Senior PM" matches
    expect(output).not.toContain('John Doe');
  });

  it('searches by company', () => {
    const output = execSync('node dist/index.js search --company Stripe').toString();
    expect(output).toContain('Jane Smith');
    expect(output).toContain('Alice Zhang');
    expect(output).not.toContain('John Doe');
  });

  it('combines filters', () => {
    const output = execSync('node dist/index.js search --role "PM" --location "SF"').toString();
    expect(output).toContain('Jane Smith');
    expect(output).toContain('Alice Zhang');
  });

  it('returns empty state gracefully', () => {
    const output = execSync('node dist/index.js search --role "CEO"').toString();
    expect(output).toContain('No contacts found');
  });
});
```

---

## Part 3: Vercel Deployment

---

### 3.1 Vercel Configuration

```json
// apps/web/vercel.json
{
  "framework": "nextjs",
  "buildCommand": "pnpm turbo build --filter=@netpro/web",
  "installCommand": "pnpm install --frozen-lockfile",
  "outputDirectory": "apps/web/.next",
  "regions": ["iad1"],
  "crons": [
    {
      "path": "/api/cron/score-decay",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/cron/retention-cleanup",
      "schedule": "0 3 * * 0"
    },
    {
      "path": "/api/cron/campaign-sender",
      "schedule": "*/15 * * * *"
    }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" }
      ]
    }
  ]
}
```

---

### 3.2 Next.js Configuration for Vercel

```typescript
// apps/web/next.config.ts
import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  // Turborepo: transpile shared packages
  transpilePackages: ['@netpro/core', '@netpro/db', '@netpro/ui'],
  
  // Output standalone for Docker (ignored by Vercel)
  output: process.env.DOCKER_BUILD ? 'standalone' : undefined,
  
  // Strict mode for catching bugs
  reactStrictMode: true,
  
  // Image optimization
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: '*.googleusercontent.com' },
    ],
  },
  
  // Environment validation at build time
  env: {
    NEXT_PUBLIC_APP_URL: process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000',
  },
  
  // Security headers
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
  
  // Webpack: handle node modules in serverless
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('better-sqlite3'); // Not needed in Vercel serverless
    }
    return config;
  },
};

// Sentry error tracking (optional, free for OSS)
export default withSentryConfig(nextConfig, {
  org: 'netpro',
  project: 'web',
  silent: true,
  widenClientFileUpload: true,
  hideSourceMaps: true,
});
```

---

### 3.3 Vercel Environment Variables Setup

```bash
# Required for Vercel deployment
vercel env add DATABASE_URL production          # Supabase connection string
vercel env add NEXTAUTH_SECRET production       # Generated 32-byte secret
vercel env add NEXTAUTH_URL production          # https://netpro.vercel.app
vercel env add GITHUB_CLIENT_ID production      # OAuth app client ID
vercel env add GITHUB_CLIENT_SECRET production  # OAuth app secret
vercel env add ENCRYPTION_MASTER_KEY production # For API key vault
vercel env add RESEND_API_KEY production        # For magic link auth

# Optional
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add INNGEST_EVENT_KEY production
vercel env add SENTRY_DSN production
```

---

### 3.4 One-Click Deploy Button

```markdown
<!-- README.md -->
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnetpro%2Fnetpro&env=DATABASE_URL,NEXTAUTH_SECRET,NEXTAUTH_URL,GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,ENCRYPTION_MASTER_KEY&envDescription=Required%20environment%20variables&envLink=https%3A%2F%2Fnetpro.dev%2Fdocs%2Fself-hosting&project-name=netpro&repository-name=netpro&root-directory=apps/web)
```

---

## Part 4: Docker Self-Hosting

---

### 4.1 Multi-Stage Dockerfile

```dockerfile
# Dockerfile
# ═══════════════════════════════════════════
# Stage 1: Dependencies
# ═══════════════════════════════════════════
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy lockfile and workspace configs
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/ui/package.json ./packages/ui/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# ═══════════════════════════════════════════
# Stage 2: Build
# ═══════════════════════════════════════════
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/ ./packages/
COPY . .

# Build with standalone output
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo build --filter=@netpro/web

# ═══════════════════════════════════════════
# Stage 3: Production Runner
# ═══════════════════════════════════════════
FROM node:20-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Security: non-root user
RUN addgroup --system --gid 1001 netpro
RUN adduser --system --uid 1001 netpro

# Copy built app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Database migrations
COPY --from=builder /app/packages/db/migrations ./migrations

# Set ownership
RUN chown -R netpro:netpro /app
USER netpro

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
```

---

### 4.2 Docker Compose (Full Self-Hosted Stack)

```yaml
# docker-compose.yml
version: '3.8'

services:
  # ─── Web Application ───
  web:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://netpro:${POSTGRES_PASSWORD}@db:5432/netpro
      - NEXTAUTH_URL=${APP_URL:-http://localhost:3000}
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - ENCRYPTION_MASTER_KEY=${ENCRYPTION_MASTER_KEY}
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - REDIS_URL=redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ─── PostgreSQL Database ───
  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=netpro
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=netpro
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U netpro"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ─── Redis (Rate Limiting + Job Queue) ───
  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 64mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 128M
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ─── Job Worker (Background Tasks) ───
  worker:
    build: .
    command: ["node", "apps/web/worker.js"]
    environment:
      - DATABASE_URL=postgresql://netpro:${POSTGRES_PASSWORD}@db:5432/netpro
      - REDIS_URL=redis://redis:6379
      - ENCRYPTION_MASTER_KEY=${ENCRYPTION_MASTER_KEY}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  # ─── Reverse Proxy (optional, for HTTPS) ───
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
```

---

### 4.3 Caddyfile (Automatic HTTPS)

```
# Caddyfile
{$APP_DOMAIN:localhost} {
    reverse_proxy web:3000
    
    # Security headers
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
    
    # Compress responses
    encode gzip zstd
    
    # Rate limiting at proxy level
    rate_limit {
        zone global {
            key {remote_host}
            events 100
            window 1m
        }
    }
}
```

---

### 4.4 Docker Environment File

```bash
# .env.docker (copy to .env for docker compose)
# ═══════════════════════════════════════
# REQUIRED
# ═══════════════════════════════════════
POSTGRES_PASSWORD=change-me-to-a-secure-password
NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32
ENCRYPTION_MASTER_KEY=generate-with-openssl-rand-base64-32
APP_URL=https://netpro.yourdomain.com
APP_DOMAIN=netpro.yourdomain.com

# ═══════════════════════════════════════
# AUTH (at least one provider)
# ═══════════════════════════════════════
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# ═══════════════════════════════════════
# OPTIONAL
# ═══════════════════════════════════════
# RESEND_API_KEY=           # For magic link auth
# SENTRY_DSN=               # Error tracking
```

---

## Part 5: CLI Distribution

---

### 5.1 npm Publishing

```json
// apps/cli/package.json
{
  "name": "@netpro/cli",
  "version": "1.0.0",
  "description": "NetPro CLI — Professional networking from your terminal",
  "bin": {
    "netpro": "./dist/index.js"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18"
  },
  "os": ["darwin", "linux", "win32"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --target node18 --clean --minify",
    "prepublishOnly": "pnpm build"
  },
  "keywords": ["networking", "linkedin", "cli", "professional", "crm"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/netpro/netpro.git",
    "directory": "apps/cli"
  }
}
```

---

### 5.2 CLI Build Pipeline (tsup)

```typescript
// apps/cli/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: true,
  minify: true,
  sourcemap: true,
  splitting: false,
  
  // Bundle everything (no external node_modules at runtime)
  noExternal: [/@netpro\/.*/],
  
  // Keep native modules external
  external: ['better-sqlite3', 'keytar'],
  
  // Add shebang
  banner: {
    js: '#!/usr/bin/env node',
  },
  
  // Inline package.json version
  define: {
    'process.env.CLI_VERSION': JSON.stringify(require('./package.json').version),
  },
});
```

---

### 5.3 Homebrew Formula

```ruby
# Formula/netpro.rb (for homebrew-tap repo)
class Netpro < Formula
  desc "Professional networking CLI - open source LinkedIn Premium alternative"
  homepage "https://netpro.dev"
  url "https://registry.npmjs.org/@netpro/cli/-/cli-1.0.0.tgz"
  sha256 "abc123..."  # Updated by release automation
  license "MIT"

  depends_on "node@20"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "netpro", shell_output("#{bin}/netpro --version")
  end
end
```

```bash
# Install via Homebrew
brew tap netpro/tap
brew install netpro
```

---

## Part 6: Monitoring & Observability

---

### 6.1 Health Check Endpoint

```typescript
// apps/web/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { db } from '@netpro/db';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};
  
  // Database check
  const dbStart = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = { status: 'healthy', latencyMs: Date.now() - dbStart };
  } catch (e) {
    checks.database = { status: 'unhealthy', error: (e as Error).message };
  }
  
  // Redis check (if configured)
  if (process.env.REDIS_URL) {
    const redisStart = Date.now();
    try {
      // ping redis
      checks.redis = { status: 'healthy', latencyMs: Date.now() - redisStart };
    } catch (e) {
      checks.redis = { status: 'unhealthy', error: (e as Error).message };
    }
  }
  
  const overall = Object.values(checks).every(c => c.status === 'healthy');
  
  return NextResponse.json({
    status: overall ? 'healthy' : 'degraded',
    version: process.env.npm_package_version ?? 'dev',
    timestamp: new Date().toISOString(),
    checks,
  }, {
    status: overall ? 200 : 503,
  });
}
```

---

### 6.2 Structured Logging

```typescript
// packages/core/src/logging/logger.ts

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  service: 'web' | 'cli' | 'worker';
  traceId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  duration_ms?: number;
}

class Logger {
  private service: 'web' | 'cli' | 'worker';
  
  constructor(service: LogEntry['service']) {
    this.service = service;
  }
  
  info(message: string, meta?: Record<string, unknown>) {
    this.emit('info', message, meta);
  }
  
  warn(message: string, meta?: Record<string, unknown>) {
    this.emit('warn', message, meta);
  }
  
  error(message: string, error?: Error, meta?: Record<string, unknown>) {
    this.emit('error', message, {
      ...meta,
      error_name: error?.name,
      error_message: error?.message,
      stack: error?.stack,
    });
  }
  
  // Measure async operation duration
  async timed<T>(operation: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.emit('info', `${operation} completed`, { ...meta, duration_ms: Date.now() - start });
      return result;
    } catch (e) {
      this.emit('error', `${operation} failed`, { ...meta, duration_ms: Date.now() - start, error: (e as Error).message });
      throw e;
    }
  }
  
  private emit(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      service: this.service,
      metadata,
    };
    
    // Structured JSON to stdout (Vercel/Docker log collectors pick this up)
    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }
}

export const logger = new Logger(
  process.env.SERVICE_NAME as any ?? 'web'
);
```

---

### 6.3 Error Tracking (Sentry)

```typescript
// apps/web/sentry.client.config.ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  
  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',
  
  // Performance: sample 10% of transactions
  tracesSampleRate: 0.1,
  
  // Session replay: 1% default, 100% on error
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,
  
  integrations: [
    Sentry.replayIntegration({
      // PII masking
      maskAllText: false,
      maskAllInputs: true, // Mask form inputs
      blockAllMedia: false,
    }),
  ],
  
  // Don't send PII
  beforeSend(event) {
    // Strip user emails, API keys from error context
    if (event.extra) {
      delete event.extra.email;
      delete event.extra.apiKey;
    }
    return event;
  },
});
```

---

### 6.4 Performance Monitoring Dashboard

```typescript
// apps/web/app/api/metrics/route.ts
// Prometheus-compatible metrics endpoint (for Grafana/self-hosted monitoring)

import { NextResponse } from 'next/server';

// In-memory metrics (reset on cold start — use Redis for persistence)
const metrics = {
  http_requests_total: new Map<string, number>(),
  http_request_duration_seconds: [] as number[],
  enrichment_requests_total: 0,
  enrichment_cache_hits: 0,
  emails_sent_total: 0,
  active_campaigns: 0,
  db_query_duration_seconds: [] as number[],
};

export async function GET() {
  // Prometheus exposition format
  const lines: string[] = [
    '# HELP http_requests_total Total HTTP requests',
    '# TYPE http_requests_total counter',
    ...Array.from(metrics.http_requests_total.entries()).map(
      ([path, count]) => `http_requests_total{path="${path}"} ${count}`
    ),
    '',
    '# HELP enrichment_cache_hit_ratio Enrichment cache hit ratio',
    '# TYPE enrichment_cache_hit_ratio gauge',
    `enrichment_cache_hit_ratio ${metrics.enrichment_cache_hits / (metrics.enrichment_requests_total || 1)}`,
    '',
    '# HELP emails_sent_total Total emails sent',
    '# TYPE emails_sent_total counter',
    `emails_sent_total ${metrics.emails_sent_total}`,
  ];
  
  return new NextResponse(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain' },
  });
}
```

---

## Part 7: Release Management

---

### 7.1 Versioning Strategy

```
Semantic Versioning: MAJOR.MINOR.PATCH

MAJOR (breaking):
  - Database schema changes requiring migration
  - CLI command interface changes
  - API response format changes

MINOR (feature):
  - New CLI commands
  - New web pages/features
  - New enrichment providers

PATCH (fix):
  - Bug fixes
  - Performance improvements
  - Security patches

Pre-release: 1.0.0-beta.1, 1.0.0-rc.1
```

---

### 7.2 Changesets (Monorepo Versioning)

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "netpro/netpro" }],
  "commit": false,
  "fixed": [],
  "linked": [["@netpro/core", "@netpro/db", "@netpro/cli", "@netpro/web"]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@netpro/config-*"]
}
```

```bash
# Developer workflow:
pnpm changeset              # Create a changeset describing your change
pnpm changeset version      # Bump versions based on changesets
pnpm changeset publish      # Publish to npm (CI does this)
```

---

### 7.3 Branch Strategy

```
main (production)
  │
  ├── release/v1.x (maintenance branch for v1)
  │
  └── develop (integration branch)
       │
       ├── feature/import-vcard
       ├── feature/warm-intro-pathfinder
       └── fix/search-score-overflow

Workflow:
1. Feature branches → develop (PR with review)
2. develop → main (release PR, auto-generated changelog)
3. main tag → triggers release workflow
4. Hotfixes → main directly (critical security fixes)
```

---

## Part 8: Infrastructure Costs (Staying Free/Cheap)

---

### 8.1 Free Tier Architecture

| Service | Free Tier | Paid Threshold | Monthly Cost After |
|---------|-----------|----------------|-------------------|
| **Vercel** | 100GB bandwidth, 100hrs compute | Heavy traffic | $20/mo (Pro) |
| **Supabase** | 500MB DB, 50K auth MAU | > 500MB data | $25/mo (Pro) |
| **Upstash Redis** | 10K commands/day | Heavy rate limiting | $10/mo |
| **GitHub Actions** | 2000 min/mo (OSS unlimited) | Private repo | Free (OSS) |
| **Sentry** | 5K errors/mo | Higher volume | Free (OSS plan) |
| **Resend** | 100 emails/day | > 3K/mo | $20/mo |
| **Inngest** | 25K events/mo | Heavy background jobs | $25/mo |

**Total cost for community edition: $0/mo** (within free tiers)  
**Total cost at moderate scale (~1K users): ~$50-100/mo**

---

### 8.2 Cost Optimization Tips

```typescript
// apps/web/next.config.ts — ISR for expensive pages
// Dashboard data refreshes every 5 minutes (not per-request)
export const revalidate = 300; // 5 minutes

// API routes: edge runtime where possible (cheaper than Node.js)
export const runtime = 'edge'; // For simple auth checks, redirects

// Database: connection pooling (critical for serverless)
// Supabase already provides pgBouncer — use transaction mode
const DATABASE_URL = process.env.DATABASE_URL + '?pgbouncer=true&connection_limit=1';
```

---

## Summary: DevOps At a Glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DEPLOYMENT MODES                                  │
├─────────────────┬───────────────────────┬───────────────────────────┤
│   Vercel Cloud  │   Docker Self-Host    │      CLI Local            │
├─────────────────┼───────────────────────┼───────────────────────────┤
│ • Zero config   │ • Full control        │ • Zero dependencies       │
│ • Auto-scale    │ • Your infrastructure │ • Offline capable         │
│ • Free tier OK  │ • Docker Compose      │ • OS keychain for secrets │
│ • Edge network  │ • Caddy for HTTPS     │ • SQLite + SQLCipher      │
│ • Cron jobs     │ • Prometheus metrics  │ • npm / brew install      │
│ • Preview URLs  │ • Grafana dashboards  │ • Cross-platform          │
├─────────────────┼───────────────────────┼───────────────────────────┤
│ Best for:       │ Best for:             │ Best for:                 │
│ Quick start,    │ Privacy-conscious,    │ Power users,              │
│ small teams     │ enterprise, GDPR      │ CLI-first workflow        │
└─────────────────┴───────────────────────┴───────────────────────────┘
```

---

*Ship fast, ship safe. Every PR gets a preview. Every release is reproducible.*
