import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).not.toContain("SECRET_VALUE_NOT_FOR_HTML");
    expect(html).not.toContain("123456789");
    expect(html).toContain('href="/settings/card"');
    expect(html).toContain("NETPRO_OWNER_GITHUB_ID");
  });

  it("does not call OAuth configured when only one credential is set", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "configured-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    const html = renderToStaticMarkup(<SettingsPage />);
    const row = html
      .split("<tr")
      .find((part) => part.includes("GitHub OAuth (sign-in)"));
    expect(row).toContain("not set");
  });
});
