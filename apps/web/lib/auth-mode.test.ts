// Phase 5 — the web UI's auth-mode resolution and local trust.
//
// These are the decisions that let local NetPro start with no GitHub
// credentials at all, so they are pinned exhaustively: every mode, every
// ambiguity, and the fail-closed answer for a remote caller.
//
// The forwarding-header cases matter more than they look: Next.js itself sets
// `x-forwarded-for` from the socket peer address, so "a proxy header exists"
// must NOT mean "proxied" — only a non-loopback *value* may.

import { describe, expect, it } from "vitest";
import {
  describeWebAuthMode,
  isGitHubConfigured,
  isLoopbackAddress,
  isLoopbackHost,
  isTrustedLocalRequest,
  resolveWebAuthMode,
  trustLocalUi,
} from "./auth-mode";

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

const headerBag = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

describe("isGitHubConfigured", () => {
  it("needs both halves of the OAuth pair", () => {
    expect(isGitHubConfigured(env({}))).toBe(false);
    expect(isGitHubConfigured(env({ GITHUB_CLIENT_ID: "id" }))).toBe(false);
    expect(isGitHubConfigured(env({ GITHUB_CLIENT_SECRET: "secret" }))).toBe(false);
    expect(
      isGitHubConfigured(env({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })),
    ).toBe(true);
    expect(
      isGitHubConfigured(env({ GITHUB_CLIENT_ID: "  ", GITHUB_CLIENT_SECRET: "secret" })),
    ).toBe(false);
  });
});

describe("resolveWebAuthMode", () => {
  it("defaults to local, not to GitHub (phase 5 exit criteria)", () => {
    expect(resolveWebAuthMode(env({}))).toBe("local");
    // The variables the old design required are simply absent here.
    expect(resolveWebAuthMode(env({ NEXTAUTH_URL: "http://localhost:3000" }))).toBe("local");
  });

  it("keeps existing GitHub deployments working by auto-detecting the OAuth pair", () => {
    expect(
      resolveWebAuthMode(env({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })),
    ).toBe("github");
  });

  it("honours an explicit mode, case-insensitively", () => {
    expect(resolveWebAuthMode(env({ NETPRO_AUTH_MODE: "LOCAL" }))).toBe("local");
    expect(resolveWebAuthMode(env({ NETPRO_AUTH_MODE: " github " }))).toBe("github");
    expect(resolveWebAuthMode(env({ NETPRO_AUTH_MODE: "open" }))).toBe("open");
  });

  it("treats the server's token mode as local-only (a browser cannot send a bearer token)", () => {
    expect(resolveWebAuthMode(env({ NETPRO_AUTH_MODE: "token" }))).toBe("local");
  });

  it("refuses to guess at a typo", () => {
    expect(() => resolveWebAuthMode(env({ NETPRO_AUTH_MODE: "public" }))).toThrow(
      /Unknown NETPRO_AUTH_MODE "public"/,
    );
    expect(() => resolveWebAuthMode(env({ NETPRO_AUTH_MODE: "public" }))).toThrow(
      /Expected "local", "token", "github", or "open"/,
    );
  });
});

describe("trustLocalUi", () => {
  it("is off unless explicitly requested", () => {
    expect(trustLocalUi(env({}))).toBe(false);
    expect(trustLocalUi(env({ NETPRO_TRUST_LOCAL_UI: "1" }))).toBe(true);
    expect(trustLocalUi(env({ NETPRO_TRUST_LOCAL_UI: "true" }))).toBe(true);
    expect(trustLocalUi(env({ NETPRO_TRUST_LOCAL_UI: "0" }))).toBe(false);
    expect(trustLocalUi(env({ NETPRO_TRUST_LOCAL_UI: "off" }))).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "localhost:3000",
    "LOCALHOST",
    "127.0.0.1",
    "127.0.0.1:3777",
    "127.9.9.9",
    "[::1]",
    "[::1]:3000",
    "::1",
    "netpro.localhost",
  ])("accepts %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["", null, undefined, "netpro.example", "10.0.0.5", "127.0.0.1.evil.com", "[fe80::1]"])(
    "rejects %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe("isLoopbackAddress", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:52341",
    "::1",
    "::ffff:127.0.0.1", // the spelling Node reports for a loopback socket
    "::ffff:7f00:1",
    "[::1]:3000",
  ])("accepts %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(["", null, undefined, "203.0.113.7", "172.17.0.1", "::ffff:172.17.0.1", "127.0.0.1.evil"])(
    "rejects %s",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});

describe("isTrustedLocalRequest", () => {
  it("trusts a direct loopback request, including the header Next.js adds itself", () => {
    expect(isTrustedLocalRequest(headerBag({ host: "127.0.0.1:3000" }))).toBe(true);
    // `next start` fills x-forwarded-for with the socket peer address.
    expect(
      isTrustedLocalRequest(
        headerBag({ host: "localhost:3000", "x-forwarded-for": "::ffff:127.0.0.1" }),
      ),
    ).toBe(true);
    expect(
      isTrustedLocalRequest(headerBag({ host: "127.0.0.1", "x-forwarded-for": "127.0.0.1, ::1" })),
    ).toBe(true);
  });

  it("withholds trust when a forwarding header names a remote caller", () => {
    expect(
      isTrustedLocalRequest(headerBag({ host: "localhost:3000", "x-forwarded-for": "203.0.113.7" })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        headerBag({ host: "localhost:3000", "x-forwarded-for": "203.0.113.7, 127.0.0.1" }),
      ),
    ).toBe(false);
    expect(isTrustedLocalRequest(headerBag({ host: "localhost", "x-real-ip": "203.0.113.7" }))).toBe(
      false,
    );
    expect(
      isTrustedLocalRequest(headerBag({ host: "localhost", forwarded: 'for=203.0.113.7;proto=http' })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(headerBag({ host: "localhost", forwarded: 'for="[::1]:3000"' })),
    ).toBe(true);
  });

  it("denies remote hosts", () => {
    expect(isTrustedLocalRequest(headerBag({ host: "netpro.example" }))).toBe(false);
    expect(isTrustedLocalRequest(headerBag({}))).toBe(false);
  });

  it("accepts the explicit loopback-only assertion (a container's peer is the Docker bridge)", () => {
    const containerRequest = headerBag({
      host: "localhost:3000",
      "x-forwarded-for": "::ffff:172.17.0.1",
    });
    expect(isTrustedLocalRequest(containerRequest)).toBe(false);
    expect(isTrustedLocalRequest(containerRequest, { trustLocalUi: true })).toBe(true);
    // The Host check is never skipped: the flag does not open up remote hosts.
    expect(
      isTrustedLocalRequest(headerBag({ host: "netpro.example" }), { trustLocalUi: true }),
    ).toBe(false);
  });

  it("honours an explicit host override (proxy.ts falls back to nextUrl.host)", () => {
    expect(
      isTrustedLocalRequest(headerBag({}), { host: "127.0.0.1:3000" }),
    ).toBe(true);
  });
});

describe("describeWebAuthMode", () => {
  it("says what each mode trusts", () => {
    expect(describeWebAuthMode("local")).toMatch(/operator on this machine/i);
    expect(describeWebAuthMode("github")).toMatch(/GitHub/i);
    expect(describeWebAuthMode("open")).toMatch(/authenticates nobody/i);
  });
});
