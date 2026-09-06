import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ conn: {} }));
vi.mock("@netpro/core/src/card/repository", () => ({
  getProfileCardState: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("LOGIN_REDIRECT");
  },
}));
import { auth } from "@/lib/auth";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import CardSettingsPage from "./page";

beforeEach(() => vi.clearAllMocks());
describe("private card page authorization", () => {
  it("checks auth before reading a draft, independent of layout/middleware", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(CardSettingsPage()).rejects.toThrow("LOGIN_REDIRECT");
    expect(getProfileCardState).not.toHaveBeenCalled();
  });

  it("loads the editor state for the authenticated owner", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
    vi.mocked(getProfileCardState).mockResolvedValue({
      draft: null,
      published: null,
      publishedAt: null,
      updatedAt: null,
    });
    expect(await CardSettingsPage()).toBeDefined();
    expect(getProfileCardState).toHaveBeenCalledOnce();
  });
});
