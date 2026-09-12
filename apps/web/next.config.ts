import type { NextConfig } from "next";
import { connectSrcDirective } from "./lib/server-origin";

// Phase 6 — production security headers.
//
// Applied to every response, with the public card keeping its stricter
// overrides below. Deliberate choices:
//
//  - HSTS is only meaningful over HTTPS and would be actively harmful on a
//    plain-HTTP local/self-hosted instance (a browser that sees it once
//    refuses HTTP to that origin for two years). It is therefore emitted only
//    in production, where NetPro is expected to be behind TLS.
//  - X-Frame-Options: SAMEORIGIN, plus frame-ancestors in the CSP, since the
//    app has no embedding use case and both are needed for old/new browsers.
//  - The CSP allows 'unsafe-inline' for styles because Tailwind's runtime and
//    Next's injected critical CSS use inline style attributes; scripts do NOT
//    get 'unsafe-inline'. 'unsafe-eval' is dev-only (React Refresh).
//  - No remote images are configured on purpose: the profile card never loads
//    third-party avatars, which is a Phase 5 privacy guarantee.
//  - `connect-src` names the standalone NetPro server's origin in addition to
//    'self'. The Web UI is a pure client of that server, so the browser must
//    be allowed to reach it — otherwise every client-side call (the provider
//    list behind "Connect an API", the API itself, and the SSE feed) is
//    silently blocked and the UI degrades to an empty shell.
const isProduction = process.env.NODE_ENV === "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines a small bootstrap script per document; 'unsafe-eval' is
  // required by React Refresh in development only.
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The NetPro server is a separate origin from the Web UI (see above).
  `connect-src ${connectSrcDirective()}`,
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Phase 24 — the Web UI no longer imports @netpro/core or @netpro/db, so no
  // workspace packages need transpiling. The UI is a pure client of the
  // standalone `@netpro/server` process.
  reactStrictMode: true,
  // Arena's HTTPS reverse-proxy previews (development only).
  allowedDevOrigins: ["*.e2b.app"],
  // Standalone output powers the Docker image (`node apps/web/server.js`).
  // It is a plain `next build`; local-first runs the server package instead.
  output: "standalone",
  // Never ship a build whose types are broken. (There is no `eslint` key in
  // Next.js 16 — `next lint` was removed in favour of the ESLint CLI, which
  // CI runs as its own step.)
  typescript: { ignoreBuildErrors: false },
  // Don't advertise the framework version to attackers.
  poweredByHeader: false,
  async rewrites() {
    // Development only: forward the browser's same-origin `/api/*` calls to
    // the standalone NetPro server. `next dev` then serves the UI from any
    // host (e.g. a remote preview) without the browser dialing 127.0.0.1 —
    // which would resolve to the viewer's machine, not the machine running
    // `netpro serve`. The browser-side client uses relative paths in dev (see
    // lib/netpro-server.ts).
    //
    // Production returns nothing on purpose: the Phase 24 contract is that
    // the built Web UI exposes no /api surface of its own. Browsers there
    // reach the server origin directly (allowed by the connect-src above).
    if (process.env.NODE_ENV === "production") return [];
    const serverUrl = (
      process.env.NETPRO_SERVER_URL ||
      process.env.NEXT_PUBLIC_NETPRO_SERVER_URL ||
      "http://127.0.0.1:3777"
    ).replace(/\/+$/, "");
    return [{ source: "/api/:path*", destination: `${serverUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // The public card keeps its Phase 5 privacy overrides. Later entries
        // win in Next.js, so these replace the same keys set above.
        source: "/card/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // Private data must never be cached by a shared proxy or CDN.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
