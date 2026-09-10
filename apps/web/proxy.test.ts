import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Test the actual routing callback without Auth.js signing/encryption or database IO.
const sessionRead = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({
  default: () => ({
    auth: (callback: (req: unknown) => unknown) => (req: unknown) => {
      sessionRead();
      return callback(req);
    },
  }),
}));
import proxy from "./proxy";

const run = (path: string, signedIn = false): Response => {
  const request = Object.assign(
    new NextRequest(`https://netpro.example${path}`),
    {
      auth: signedIn ? { user: { id: "owner" } } : null,
    },
  );
  return (proxy as unknown as (req: typeof request) => Response)(request);
};

beforeEach(() => {
  vi.clearAllMocks();
  // Most of this file covers the private/public route matrix as it behaves in
  // a GitHub-authenticated deployment, so configure the OAuth pair. Local-mode
  // behaviour (phase 5) is covered explicitly in the block below and in
  // lib/auth-mode.test.ts.
  vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
});
afterEach(() => vi.unstubAllEnvs());

const runAt = (
  path: string,
  origin: string,
  signedIn = false,
  extraHeaders: Record<string, string> = {},
): Response => {
  const request = Object.assign(
    new NextRequest(`${origin}${path}`, { headers: extraHeaders }),
    { auth: signedIn ? { user: { id: "owner" } } : null },
  );
  return (proxy as unknown as (req: typeof request) => Response)(request);
};
describe("proxy route boundaries", () => {
  it("does not read sessions or create auth cookies for public visitors", () => {
    run("/card");
    run("/card/vcard");
    run("/api/card/pixel.gif");
    run("/api/card/view");
    expect(sessionRead).not.toHaveBeenCalled();
  });
  it.each([
    "/card",
    "/card/vcard",
    "/api/auth/callback/github",
    "/api/health",
    "/api/card/pixel.gif",
    "/api/card/view",
  ])("leaves %s public", (path) => {
    expect(run(path).status).toBe(200);
  });

  it.each([
    "/api/card",
    "/api/card/views",
    "/api/card/views?days=7",
    "/api/search",
    "/api/authentication",
    "/api/healthcheck",
  ])("requires auth for %s, without loose public-prefix matches", (path) => {
    expect(run(path).status).toBe(401);
  });

  it("keeps the owner card API private even though the two beacon paths under it are public (v2.5 phase 2)", () => {
    expect(run("/api/card").status).toBe(401);
    expect(run("/api/card/anything-else").status).toBe(401);
    expect(run("/api/card/pixel.gif").status).toBe(200);
    expect(run("/api/card/view").status).toBe(200);
    expect(run("/api/card/pixel.gif", true).status).toBe(200);
  });

  it("keeps the viewer-analytics API private while the beacons stay public (v2.5 phase 3)", () => {
    // `/api/card/views` must not prefix-match the public `/api/card/view`.
    expect(run("/api/card/views").status).toBe(401);
    expect(run("/api/card/views", true).status).toBe(200);
    expect(run("/api/card/view").status).toBe(200);
  });

  it.each(["/graph", "/graph/some-contact-id"])("redirects %s to login when signed out (v2.0 Phase 3)", (path) => {
    expect(run(path).status).toBe(307);
    expect(run(path).headers.get("location")).toBe("https://netpro.example/login");
    expect(run(path, true).status).toBe(200);
  });

  it.each(["/skills", "/skills/anything"])("redirects %s to login when signed out (v2.0 Phase 5)", (path) => {
    expect(run(path).status).toBe(307);
    expect(run(path).headers.get("location")).toBe("https://netpro.example/login");
    expect(run(path, true).status).toBe(200);
  });

  it("protects the skills APIs with 401 and permits the owner", () => {
    expect(run("/api/skills/gap?role=x").status).toBe(401);
    expect(run("/api/skills/extract").status).toBe(401);
    expect(run("/api/skills/gap?role=x", true).status).toBe(200);
  });

  it.each(["/events", "/events/some-event-id"])("redirects %s to login when signed out (v2.0 Phase 6)", (path) => {
    expect(run(path).status).toBe(307);
    expect(run(path).headers.get("location")).toBe("https://netpro.example/login");
    expect(run(path, true).status).toBe(200);
  });

  it("protects the events APIs with 401 and permits the owner", () => {
    expect(run("/api/events").status).toBe(401);
    expect(run("/api/events/some-id").status).toBe(401);
    expect(run("/api/events/some-id/match").status).toBe(401);
    expect(run("/api/events?query=x", true).status).toBe(200);
  });

  it.each(["/content", "/content/some-content-id"])(
    "redirects %s to login when signed out (v2.5 Phase 5)",
    (path) => {
      expect(run(path).status).toBe(307);
      expect(run(path).headers.get("location")).toBe("https://netpro.example/login");
      expect(run(path, true).status).toBe(200);
    }
  );

  it("protects the content APIs with 401 and permits the owner (v2.5 Phase 5)", () => {
    expect(run("/api/content").status).toBe(401);
    expect(run("/api/content/some-id").status).toBe(401);
    expect(run("/api/content/some-id/metrics").status).toBe(401);
    expect(run("/api/content/some-id/mentions").status).toBe(401);
    expect(run("/api/content?platform=blog", true).status).toBe(200);
  });

  it("protects the graph APIs with 401 and permits the owner", () => {
    expect(run("/api/graph/paths?target=x").status).toBe(401);
    expect(run("/api/graph/overview").status).toBe(401);
    expect(run("/api/graph/paths?target=x", true).status).toBe(200);
  });

  it("redirects the private editor to login and permits authenticated requests", () => {
    expect(run("/settings/card").status).toBe(307);
    expect(run("/settings/card").headers.get("location")).toBe(
      "https://netpro.example/login",
    );
    expect(run("/settings/card", true).status).toBe(200);
    expect(run("/api/card", true).status).toBe(200);
  });
});

describe("proxy auth modes (phase 5)", () => {
  it("trusts a direct loopback request in the default local mode, with no cookies", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "local");
    expect(runAt("/graph", "http://127.0.0.1:3777").status).toBe(200);
    expect(runAt("/api/card", "http://localhost:3000").status).toBe(200);
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("still denies a remote caller in local mode (fail closed)", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "local");
    expect(runAt("/graph", "https://netpro.example").status).toBe(307);
    expect(runAt("/api/card", "https://netpro.example").status).toBe(401);
    // Public pages stay public for everyone.
    expect(runAt("/card", "https://netpro.example").status).toBe(200);
  });

  it("does not trust a loopback Host when a proxy forwarded the request", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "local");
    expect(
      runAt("/graph", "http://localhost:3000", false, { "x-forwarded-for": "203.0.113.7" }).status,
    ).toBe(307);
  });

  it("open mode trusts everyone, because something else authenticates callers", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "open");
    expect(runAt("/api/card", "https://netpro.example").status).toBe(200);
    expect(runAt("/graph", "https://netpro.example").status).toBe(200);
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("treats the server's token mode as local-only for browsers", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "token");
    expect(runAt("/graph", "http://localhost:3000").status).toBe(200);
    expect(runAt("/graph", "https://netpro.example").status).toBe(307);
  });

  it("answers a misconfigured mode with an explicit 500 instead of guessing", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "public");
    const response = runAt("/graph", "http://localhost:3000");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });
});

describe("proxy without any auth provider (phase 5)", () => {
  it("denies remote callers without consulting Auth.js when GitHub is unconfigured", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    vi.stubEnv("NETPRO_AUTH_MODE", "");
    expect(runAt("/api/card", "https://netpro.example").status).toBe(401);
    expect(runAt("/graph", "https://netpro.example").status).toBe(307);
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("still serves the local operator and the public card", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    vi.stubEnv("NETPRO_AUTH_MODE", "");
    expect(runAt("/graph", "http://localhost:3000").status).toBe(200);
    expect(runAt("/card", "https://netpro.example").status).toBe(200);
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("accepts the explicit loopback-only assertion for port-published containers", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    vi.stubEnv("NETPRO_TRUST_LOCAL_UI", "1");
    // In a container the peer is the Docker bridge, which Next puts in
    // x-forwarded-for; the operator's loopback-only publish is the assertion.
    expect(
      runAt("/graph", "http://localhost:3000", false, { "x-forwarded-for": "::ffff:172.17.0.1" })
        .status,
    ).toBe(200);
    expect(runAt("/graph", "https://netpro.example").status).toBe(307);
  });
});
