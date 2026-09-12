// apps/web/lib/server-origin.ts
//
// The single source of truth for the NetPro server origin(s) the Web UI talks
// to. The Web UI is a pure client of the standalone @netpro/server, which
// lives on its own origin (http://127.0.0.1:3777 by default). Two consumers
// share this resolution:
//
//   * next.config.ts — emits `connect-src` so the page's CSP lets the browser
//     fetch the server origin. The provider list behind Settings → "Connect
//     an API", every client-side API call, and the live SSE feed all go
//     there, and a CSP of `connect-src 'self'` silently blocks them all (the
//     browser shows an empty provider dropdown with no obvious error).
//   * lib/netpro-server.ts — builds the absolute request/EventSource URLs.
//
// Two different variables serve two different callers:
//
//   * NEXT_PUBLIC_NETPRO_SERVER_URL is baked into the client bundle at build
//     time and is the origin the *browser* reaches.
//   * NETPRO_SERVER_URL is read by *server-rendered* code at request time —
//     in Docker that is the private compose hostname (http://server:3777),
//     not an address the browser can use.

const DEFAULT_ORIGIN = "http://127.0.0.1:3777";

function stripTrailingSlash(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/** The origin server-rendered requests use (NETPRO_SERVER_URL first). */
export function resolveServerOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.NETPRO_SERVER_URL?.trim() ||
    env.NEXT_PUBLIC_NETPRO_SERVER_URL?.trim() ||
    DEFAULT_ORIGIN;
  return stripTrailingSlash(raw);
}

/** The origin the browser reaches (the baked public URL first). */
export function resolveBrowserServerOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    env.NEXT_PUBLIC_NETPRO_SERVER_URL?.trim() ||
    env.NETPRO_SERVER_URL?.trim() ||
    DEFAULT_ORIGIN;
  return stripTrailingSlash(raw);
}

/** The `connect-src` value that lets the page reach the NetPro server. */
export function connectSrcDirective(env: NodeJS.ProcessEnv = process.env): string {
  const origins = new Set<string>([DEFAULT_ORIGIN]);
  for (const raw of [env.NEXT_PUBLIC_NETPRO_SERVER_URL, env.NETPRO_SERVER_URL]) {
    const value = raw?.trim();
    if (value) origins.add(stripTrailingSlash(value));
  }
  // The loopback default is always present so a browser running the built UI
  // on the same machine as `netpro serve` works out of the box. The CSP is
  // emitted from the values present at build time (Next.js serialises
  // headers()); those are the same values inlined into the client bundle, so
  // the origins the browser calls are always the origins the policy allows.
  return `'self' ${[...origins].join(" ")}`;
}
