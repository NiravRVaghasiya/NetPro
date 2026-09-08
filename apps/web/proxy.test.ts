import { beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => vi.clearAllMocks());
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
