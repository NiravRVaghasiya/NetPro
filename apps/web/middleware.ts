// apps/web/middleware.ts
import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';

const { auth } = NextAuth(authConfig);

const PROTECTED_ROUTES = ['/dashboard', '/search', '/outreach', '/contacts', '/settings', '/import'];
const PUBLIC_ROUTES = ['/login', '/card', '/api/auth', '/api/health'];

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  if (PROTECTED_ROUTES.some((route) => pathname.startsWith(route))) {
    if (!req.auth?.user) {
      return NextResponse.redirect(new URL('/login', req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
