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
import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
} from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);
const PROTECTED_ROUTES = [
  "/dashboard",
  "/search",
  "/outreach",
  "/contacts",
  "/edges",
  "/settings",
  "/import",
];
const PUBLIC_ROUTES = ["/login", "/card", "/api/auth", "/api/health"];

function within(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

// Type the event to select Auth.js's middleware overload, not its route-handler overload.
const authenticate = auth((req, _event: NextFetchEvent) => {
  const { pathname } = req.nextUrl;
  // All other APIs are private by default, including future data routes.
  if (within(pathname, "/api")) {
    if (!req.auth?.user) {
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
    !req.auth?.user
  ) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Public-card visitors need no session processing or Auth.js cookies.
  // In particular, don't wrap this early return in auth(), which sets cookies
  // even for anonymous visitors. Auth route handlers manage their own cookies.
  if (PUBLIC_ROUTES.some((route) => within(request.nextUrl.pathname, route))) {
    return NextResponse.next();
  }
  return authenticate(request, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
