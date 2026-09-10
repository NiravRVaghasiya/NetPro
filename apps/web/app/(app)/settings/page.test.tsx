import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The page reads the local installation identity, which would touch
// ~/.netpro on the machine running the tests. Pin it instead.
vi.mock("@/lib/local-owner", () => ({
  resolveInstallationIdentity: () => ({
    identity: {
      id: "ins_test_installation",
      createdAt: "2026-09-10T00:00:00.000Z",
      owner: "Test Owner",
    },
    persisted: true,
  }),
}));

import SettingsPage from "./page";

afterEach(() => vi.unstubAllEnvs());
describe("settings configuration status", () => {
  it("never renders secret values and links to the private card editor", () => {
    for (const key of [
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "HUNTER_API_KEY",
      "PDL_API_KEY",
      "CLEARBIT_API_KEY",
    ]) {
      vi.stubEnv(key, "SECRET_VALUE_NOT_FOR_HTML");
    }
    vi.stubEnv("NETPRO_OWNER_GITHUB_ID", "123456789");
    vi.stubEnv("NETPRO_AUTH_MODE", "github");
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).not.toContain("SECRET_VALUE_NOT_FOR_HTML");
    expect(html).not.toContain("123456789");
    expect(html).toContain('href="/settings/card"');
    // GitHub is described as optional, and the auth mode is what is surfaced.
    expect(html).toContain("NETPRO_AUTH_MODE");
    expect(html).toContain("ins_test_installation");
  });

  it("shows the installation identity without exposing anything secret (phase 5)", () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "local");
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain("ins_test_installation");
    expect(html).toContain("Test Owner");
  });

  it("does not call OAuth configured when only one credential is set", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "configured-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    const html = renderToStaticMarkup(<SettingsPage />);
    const row = html
      .split("<tr")
      .find((part) => part.includes("GitHub OAuth (optional integration)"));
    expect(row).toBeDefined();
    expect(row).toContain("not set");
  });
});
