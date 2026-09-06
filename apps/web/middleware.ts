// Keep the JWT-only auth config here, not lib/auth (which imports native SQLite).
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

export default function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
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
