// apps/web/lib/auth-mode.ts
// Phase 5 — how the web UI decides *who is calling*, without GitHub OAuth
// being the only possible answer.
//
// Three modes, chosen by the `NETPRO_AUTH_MODE` environment variable:
//
//   local  (default when GitHub is not configured)
//          The browser talking to this process from the same machine is the
//          operator: `~/.netpro/config.toml`'s installation identity is the
//          session. Requests arriving any other way are not trusted and fall
//          through to a normal Auth.js session (which only exists if GitHub
//          sign-in is configured). This is what makes `netpro init` +
//          `netpro serve` — or `npm run dev` — work with *zero* credentials.
//
//   github The v3.0 behaviour: GitHub OAuth is the sign-in method. Selected
//          automatically when GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET are set,
//          so existing hosted deployments keep working unchanged.
//
//   open   Nothing authenticates the caller; something else does (a reverse
//          proxy with its own auth, a VPN, an isolated network). Every request
//          gets the installation-owner session.
//
// `token` is a valid *server* mode (bearer credentials checked by
// `netpro serve`), but a browser cannot attach a bearer token to a
// navigation, so the web UI treats it as `local`: loopback is trusted and
// everyone else is denied until a browser-capable mode is chosen. Every
// branch fails closed for remote callers.
//
// EDGE-SAFE: this module is imported by proxy.ts. It must not import
// `@netpro/db`, `./db`, `./auth`, or anything else that pulls in
// better-sqlite3. It therefore duplicates the *shape* of the server's auth
// modes rather than importing the type — the two are pinned together by
// tests, not by a shared module.

export type WebAuthMode = "local" | "github" | "open";

/** Credentials that make GitHub sign-in possible at all. */
export function isGitHubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim(),
  );
}

/**
 * Resolve the web UI's auth mode.
 *
 * An unrecognised `NETPRO_AUTH_MODE` throws: a typo must never decide which
 * security policy runs. proxy.ts turns that into an explicit 500 with the
 * message, so the misconfiguration is visible instead of silently ignored.
 */
export function resolveWebAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): WebAuthMode {
  const raw = env.NETPRO_AUTH_MODE?.trim().toLowerCase();
  if (!raw) return isGitHubConfigured(env) ? "github" : "local";
  if (raw === "open") return "open";
  if (raw === "github") return "github";
  if (raw === "local" || raw === "token") return "local";
  throw new Error(
    `Unknown NETPRO_AUTH_MODE "${env.NETPRO_AUTH_MODE}". Expected "local", "token", "github", or "open".`,
  );
}

/**
 * Next.js sets `x-forwarded-for` itself from the socket peer address when the
 * client did not send one, so the *presence* of a forwarding header means
 * nothing — only its values do. These are the headers that can carry the
 * original caller's address.
 */
export type HeadersLike = { get(name: string): string | null };

/** Every address a forwarding header mentions, in order. */
function forwardedAddresses(headers: HeadersLike): string[] {
  const found: string[] = [];
  const xff = headers.get("x-forwarded-for");
  if (xff) found.push(...xff.split(","));
  const realIp = headers.get("x-real-ip");
  if (realIp) found.push(realIp);
  const forwarded = headers.get("forwarded");
  if (forwarded) {
    // RFC 7239: `for=192.0.2.1;proto=https, for="[2001:db8::1]:1234"`.
    for (const match of forwarded.matchAll(/for\s*=\s*("[^"]*"|[^;,\s]+)/gi)) {
      found.push(match[1]!.replace(/^"|"$/g, ""));
    }
  }
  return found.map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * Is this address the local machine?
 *
 * Accepts IPv4, IPv6 (`::1`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`, the form
 * Node reports for a loopback socket), and bracketed/port-suffixed spellings.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let value = address.trim().toLowerCase();

  // "[::1]:3000" → "::1"
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    value = end === -1 ? value : value.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":")); // "127.0.0.1:52341"
  }

  // IPv4-mapped IPv6 in its compact hex spelling ("::ffff:7f00:1"), which some
  // runtimes and proxies use for 127.0.0.1.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) return parseInt(mappedHex[1]!, 16) === 0x7f00;

  // IPv4-mapped IPv6 in dotted form ("::ffff:127.0.0.1") — how Node reports a
  // loopback socket peer.
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);

  if (value === "::1" || value === "0:0:0:0:0:0:0:1" || value === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Is this host name the local machine?
 *
 * Accepts `localhost`, `*.localhost`, `127.0.0.0/8`, and `::1`, with or
 * without a port.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) return isLoopbackAddress(trimmed);
  if (trimmed === "::1" || trimmed === "0:0:0:0:0:0:0:1") return true;
  const name = trimmed.split(":")[0] ?? "";
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

export type LocalTrustOptions = {
  /** Override the Host header (proxy.ts also consults `nextUrl.host`). */
  host?: string | null;
  /**
   * The operator has asserted this instance is reachable only from this
   * machine (`NETPRO_TRUST_LOCAL_UI`). Necessary in a container, where a
   * browser on the host reaches the app through the Docker bridge and the
   * socket peer is therefore not loopback.
   */
  trustLocalUi?: boolean;
};

/**
 * Is this request *directly* from the local machine?
 *
 * Requirements:
 *   1. the Host header names a loopback address, and
 *   2. every address mentioned by a forwarding header is loopback — a request
 *      that travelled through a proxy took a network path, so "the browser is
 *      on this machine" cannot be assumed. (Next.js fills `x-forwarded-for`
 *      with the socket peer address itself, which satisfies this for a direct
 *      connection.)
 *
 * The residual caveat is honest and worth stating: Host is supplied by the
 * client. In `local` mode this instance must therefore be reachable only from
 * the machine it runs on — bind it to 127.0.0.1 (or publish a container port
 * on 127.0.0.1, with `NETPRO_TRUST_LOCAL_UI=1` since the container sees the
 * Docker bridge as its peer). Exposing it on a public interface requires
 * `github` or `open` mode, which is what the startup checks and docs say.
 */
export function isTrustedLocalRequest(
  headers: HeadersLike,
  options: LocalTrustOptions = {},
): boolean {
  const host = options.host ?? headers.get("host");
  if (!isLoopbackHost(host)) return false;
  if (options.trustLocalUi) return true;
  return forwardedAddresses(headers).every((address) => isLoopbackAddress(address));
}

/** `NETPRO_TRUST_LOCAL_UI` — see LocalTrustOptions.truthy unless explicitly disabled. */
export function trustLocalUi(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NETPRO_TRUST_LOCAL_UI?.trim().toLowerCase();
  if (!raw) return false;
  return !/^(0|false|no|off)$/.test(raw);
}

/** One-line description for logs, banners, and the login page. */
export function describeWebAuthMode(mode: WebAuthMode): string {
  switch (mode) {
    case "local":
      return "local mode — the operator on this machine is trusted; GitHub sign-in is optional and off unless configured";
    case "github":
      return "GitHub OAuth — every caller signs in with GitHub";
    case "open":
      return "open — NetPro authenticates nobody; a reverse proxy or private network must";
  }
}
