import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        host: "netpro.example",
        "x-forwarded-proto": "https",
      }),
  ),
}));
import { auth } from "@/lib/auth";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import CardSettingsPage from "./page";

const editorState = {
  draft: null,
  published: null,
  publishedAt: null,
  updatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
  vi.mocked(getProfileCardState).mockResolvedValue(editorState as never);
  delete process.env.NETPRO_DISABLE_VIEWS;
});

describe("private card page authorization", () => {
  it("checks auth before reading a draft, independent of layout/middleware", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(CardSettingsPage()).rejects.toThrow("LOGIN_REDIRECT");
    expect(getProfileCardState).not.toHaveBeenCalled();
  });

  it("loads the editor state for the authenticated owner", async () => {
    expect(await CardSettingsPage()).toBeDefined();
    expect(getProfileCardState).toHaveBeenCalledOnce();
  });
});

describe("profile view tracking panel (v2.5 phase 2)", () => {
  it("documents what is and is not stored, with a copy-paste embed snippet", async () => {
    const html = renderToStaticMarkup(await CardSettingsPage());
    expect(html).toContain("Profile view tracking");
    expect(html).toContain("Enabled");
    // The snippet is built from the instance's public origin.
    expect(html).toContain(
      "https://netpro.example/api/card/pixel.gif?p=blog",
    );
    expect(html).toContain("Never stored");
    expect(html).toContain("raw IP addresses");
    expect(html).toContain("90 days");
  });

  it("shows the disabled state when NETPRO_DISABLE_VIEWS is set", async () => {
    process.env.NETPRO_DISABLE_VIEWS = "true";
    try {
      const html = renderToStaticMarkup(await CardSettingsPage());
      expect(html).toContain("Disabled (NETPRO_DISABLE_VIEWS)");
      expect(html).not.toContain(">Enabled<");
    } finally {
      delete process.env.NETPRO_DISABLE_VIEWS;
    }
  });
});
