import type { NextConfig } from "next";

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
const isProduction = process.env.NODE_ENV === "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines a small bootstrap script per document; 'unsafe-eval' is
  // required by React Refresh in development only.
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // GitHub OAuth is a top-level redirect, not a fetch, so 'self' suffices.
  "connect-src 'self'",
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
  transpilePackages: ["@netpro/core", "@netpro/db", "@netpro/ui"],
  reactStrictMode: true,
  // Arena's HTTPS reverse-proxy previews (development only).
  allowedDevOrigins: ["*.e2b.app"],
  // Standalone output powers the Docker image. Vercel ignores it and uses its
  // own serverless build, so a single setting serves both targets.
  output: "standalone",
  // Never ship a build whose types are broken. (There is no `eslint` key in
  // Next.js 16 — `next lint` was removed in favour of the ESLint CLI, which
  // CI runs as its own step.)
  typescript: { ignoreBuildErrors: false },
  // Don't advertise the framework version to attackers.
  poweredByHeader: false,
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
