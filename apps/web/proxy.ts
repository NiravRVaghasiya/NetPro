// Request boundary for the private workspace (Next.js "proxy" convention).
//
// PHASE 6 — renamed from middleware.ts. Next.js 16 deprecated the middleware
// file convention in favour of proxy.ts and warned about it on every build
// ("The \"middleware\" file convention is deprecated. Please use \"proxy\"
// instead."); the convention is slated for removal in a later major. The
// exported function must be named `proxy` or be the default export; the
// `config.matcher` syntax is unchanged.
//
// Note the runtime change that comes with it: proxy always runs on the Node.js
// runtime and Next.js *errors* if a route segment runtime is declared here.
// This file stays edge-safe anyway — it still imports only the JWT-only
// `auth.config`, never `lib/auth`/`lib/db`/`@netpro/db`, all of which pull in
// the better-sqlite3 native addon. Keeping that discipline means the boundary
// does no database IO per request, which matters more on serverless than it
// did on a long-lived server.
//
// v3.0 Phase 1 — /invite is a protected route accessible to any authenticated
// GitHub user (even without workspace membership) so invitees can accept
// their invite after signing in. Other protected routes enforce membership
// in server components via requireScope().
import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
} from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import {
  isGitHubConfigured,
  isTrustedLocalRequest,
  resolveWebAuthMode,
  trustLocalUi,
} from "@/lib/auth-mode";

const { auth } = NextAuth(authConfig);
const PROTECTED_ROUTES = [
  "/dashboard",
  "/search",
  "/outreach",
  "/contacts",
  "/edges",
  "/graph",
  "/skills",
  "/events",
  "/content",
  "/settings",
  "/import",
  "/invite",
];
// The profile-view beacons (v2.5 Phase 2) are public ON PURPOSE — they
// serve anonymous card visitors and the owner's cross-origin embeds. They
// never read contact data, never set cookies, and rate-limit in memory.
// `/api/card` itself stays owner-only: only these two exact paths are
// public.
const PUBLIC_ROUTES = [
  "/login",
  "/card",
  "/api/auth",
  "/api/health",
  "/api/card/pixel.gif",
  "/api/card/view",
];

function within(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

/**
 * Refuse a request that is not the local operator.
 *
 * `authenticated` is whether Auth.js found a session — so a call site that
 * already knows there is no provider passes `false` and skips the session
 * lookup entirely (and the UntrustedHost error Auth.js logs on every remote
 * request to a deployment with no configured origin).
 */
function deny(request: NextRequest, authenticated: boolean): NextResponse {
  const { pathname } = request.nextUrl;
  // All other APIs are private by default, including future data routes.
  if (within(pathname, "/api")) {
    if (!authenticated) {
      return NextResponse.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    return NextResponse.next();
  }
  if (
    PROTECTED_ROUTES.some((route) => within(pathname, route)) &&
    !authenticated
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

// Type the event to select Auth.js's middleware overload, not its route-handler overload.
const authenticate = auth((req, _event: NextFetchEvent) =>
  deny(req as NextRequest, Boolean(req.auth?.user)),
);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  let mode;
  try {
    mode = resolveWebAuthMode();
  } catch (error) {
    // A typo in NETPRO_AUTH_MODE must not silently pick a policy — say what is
    // wrong, loudly, instead of 404-ing or, worse, trusting the caller.
    return new NextResponse(
      `NetPro is misconfigured: ${error instanceof Error ? error.message : String(error)}\n`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Public-card visitors need no session processing or Auth.js cookies.
  // In particular, don't wrap this early return in auth(), which sets cookies
  // even for anonymous visitors. Auth route handlers manage their own cookies.
  if (PUBLIC_ROUTES.some((route) => within(request.nextUrl.pathname, route))) {
    return NextResponse.next();
  }

  // Phase 5 — local mode: a request straight from this machine is the
  // operator, and it is trusted without a session round-trip (or cookies).
  // Anything arriving through a proxy, or from another host, falls through to
  // the session check below, which denies it unless GitHub sign-in is
  // configured. `open` mode trusts everyone because something else
  // authenticates callers (reverse proxy, VPN, private network).
  if (mode === "open") return NextResponse.next();
  if (
    mode === "local" &&
    isTrustedLocalRequest(request.headers, {
      // Next derives nextUrl from the Host header; falling back to it keeps
      // the check honest when the header itself is absent.
      host: request.headers.get("host") ?? request.nextUrl.host,
      trustLocalUi: trustLocalUi(),
    })
  ) {
    return NextResponse.next();
  }

  if (mode === "local" && !isGitHubConfigured()) {
    // No session can exist: GitHub sign-in has no credentials. Deny directly
    // rather than asking Auth.js for a session it cannot produce.
    return deny(request, false);
  }

  return authenticate(request, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
