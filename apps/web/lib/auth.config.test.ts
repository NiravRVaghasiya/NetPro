import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "./auth.config";
import { isOwnerGitHubId } from "./owner";

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("NETPRO_OWNER_GITHUB_ID", "12345"));

const callbacks = authConfig.callbacks;
const jwt = (input: Record<string, unknown>) =>
  callbacks.jwt(input as Parameters<typeof callbacks.jwt>[0]);
const signIn = (provider: string, id: string) =>
  callbacks.signIn({
    account: { provider, providerAccountId: id, type: "oauth" },
    user: { id: "local-user" },
  });

describe("single-owner GitHub authorization", () => {
  it("accepts exactly the configured stable GitHub account ID", async () => {
    expect(isOwnerGitHubId("12345")).toBe(true);
    expect(await signIn("github", "12345")).toBe(true);
    expect(await signIn("github", "99999")).toBe(false);
    expect(await signIn("other-provider", "12345")).toBe(false);
  });

  it.each(["", " ", "owner-name", "0", "12345,99999"])(
    "fails closed with owner configuration %j",
    async (owner) => {
      vi.stubEnv("NETPRO_OWNER_GITHUB_ID", owner);
      expect(await signIn("github", "12345")).toBe(false);
    },
  );

  it("records owner identity on initial sign-in", async () => {
    const token = await jwt({
      token: {},
      user: { id: "local-user" },
      account: { provider: "github", providerAccountId: "12345" },
    });
    expect(token).toMatchObject({ userId: "local-user", githubId: "12345" });
  });

  it("invalidates non-owner and pre-upgrade sessions", async () => {
    expect(await jwt({ token: { userId: "legacy" } })).toBeNull();
    expect(
      await jwt({ token: { userId: "intruder", githubId: "99999" } }),
    ).toBeNull();
    expect(await jwt({ token: { githubId: "12345" } })).toBeNull();
  });

  it("revalidates the owner on every session read, including configuration changes", async () => {
    const token = { userId: "owner", githubId: "12345" };
    expect(await jwt({ token })).toEqual(token);
    vi.stubEnv("NETPRO_OWNER_GITHUB_ID", "67890");
    expect(await jwt({ token })).toBeNull();
  });

  it("does not trust identities supplied by a client session update", async () => {
    expect(
      await jwt({
        token: { userId: "intruder", githubId: "99999" },
        trigger: "update",
        session: { githubId: "12345", userId: "owner" },
      }),
    ).toBeNull();
  });
});
