import { describe, expect, it } from "vitest";
import { resolveTrustHost } from "./trust-host";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("resolveTrustHost", () => {
  it("trusts the host when NEXTAUTH_URL names the app origin", () => {
    // THE REGRESSION THIS GUARDS: Auth.js v5 derives trustHost from
    // AUTH_URL/AUTH_TRUST_HOST/VERCEL/CF_PAGES/NODE_ENV — never NEXTAUTH_URL.
    // A self-hosted production deploy configured exactly as NetPro's docs and
    // docker-compose.yml describe therefore failed every authenticated
    // request with UntrustedHost, while working fine in development.
    expect(resolveTrustHost(env({ NEXTAUTH_URL: "https://netpro.example" }))).toBe(
      true,
    );
  });

  it("trusts the host for the Auth.js-native AUTH_URL spelling", () => {
    expect(resolveTrustHost(env({ AUTH_URL: "https://netpro.example" }))).toBe(true);
  });

  it("honours an explicit AUTH_TRUST_HOST opt-in", () => {
    expect(resolveTrustHost(env({ AUTH_TRUST_HOST: "true" }))).toBe(true);
  });

  it("honours an explicit opt-out even when an app URL is configured", () => {
    // An operator behind an untrusted proxy must be able to force this off.
    expect(
      resolveTrustHost(
        env({ AUTH_TRUST_HOST: "false", NEXTAUTH_URL: "https://netpro.example" }),
      ),
    ).toBe(false);
  });

  it("defers to Auth.js when nothing is configured, rather than widening trust", () => {
    // Returning `true` here would trust arbitrary Host headers on an
    // unconfigured instance — strictly worse than Auth.js's own default.
    expect(resolveTrustHost(env({}))).toBeUndefined();
  });

  it("ignores blank values that only look configured", () => {
    expect(resolveTrustHost(env({ NEXTAUTH_URL: "   ", AUTH_URL: "" }))).toBeUndefined();
  });
});
