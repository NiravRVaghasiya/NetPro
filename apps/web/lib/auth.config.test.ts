/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "./auth.config";

// v3.0 Phase 1: edge-safe auth allows any GitHub account; membership / break-glass
// owner checks happen in Node runtime (auth.ts). These tests cover the edge-safe
// portion only.

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("NETPRO_OWNER_GITHUB_ID", "12345"));

const callbacks = authConfig.callbacks;
const jwt = (input: Record<string, unknown>) =>
  callbacks.jwt(input as Parameters<typeof callbacks.jwt>[0]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const signIn = (provider: string, id: string) =>
  callbacks.signIn({
    account: { provider, providerAccountId: id, type: "oauth" },
    user: { id: "local-user" },
  } as any);

describe("v3.0 multi-user GitHub authorization (edge-safe)", () => {
  it("accepts any GitHub account at edge layer, rejects non-GitHub providers", async () => {
    expect(await signIn("github", "12345")).toBe(true);
    expect(await signIn("github", "99999")).toBe(true);
    expect(await signIn("other-provider", "12345")).toBe(false);
  });

  it("records GitHub identity on initial sign-in", async () => {
    const token = await jwt({
      token: {},
      user: { id: "local-user" },
      account: { provider: "github", providerAccountId: "12345" },
    });
    expect(token).toMatchObject({ userId: "local-user", githubId: "12345" });
  });

  it("invalidates sessions missing githubId or userId (pre-upgrade)", async () => {
    expect(await jwt({ token: { userId: "legacy" } })).toBeNull();
    expect(await jwt({ token: { githubId: "12345" } })).toBeNull();
    expect(await jwt({ token: {} })).toBeNull();
  });

  it("keeps valid sessions with both ids (membership checked in Node runtime)", async () => {
    const token = { userId: "owner", githubId: "12345" };
    expect(await jwt({ token })).toMatchObject(token);
    const intruder = { userId: "intruder", githubId: "99999" };
    // Edge layer does NOT reject intruder; Node layer will enforce membership
    expect(await jwt({ token: intruder })).toMatchObject(intruder);
  });

  it("does not trust identities supplied by a client session update - still requires valid token", async () => {
    // In v3.0 edge layer, update trigger doesn't change token, but we still
    // require githubId+userId to be present; client cannot inject arbitrary ids
    // because token is the source of truth, not session param.
    const token = await jwt({
      token: { userId: "intruder", githubId: "99999" },
      trigger: "update",
      session: { githubId: "12345", userId: "owner" },
    });
    // Edge layer keeps existing token (doesn't trust session param to overwrite)
    expect(token).toMatchObject({ userId: "intruder", githubId: "99999" });
  });
});
