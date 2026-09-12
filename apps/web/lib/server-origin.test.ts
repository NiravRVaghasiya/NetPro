// apps/web/lib/server-origin.test.ts
//
// Pins the origin the browser is allowed (and directed) to reach the
// standalone NetPro server on. A `connect-src 'self'` CSP silently blocks the
// cross-origin provider-list fetch behind Settings → "Connect an API", which
// is the failure behind "I cannot choose a provider".

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectSrcDirective,
  resolveBrowserServerOrigin,
  resolveServerOrigin,
} from "./server-origin";

describe("resolveBrowserServerOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the local server", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(resolveBrowserServerOrigin()).toBe("http://127.0.0.1:3777");
  });

  it("prefers the browser-facing public URL", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "https://api.example.com:3777");
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    expect(resolveBrowserServerOrigin()).toBe("https://api.example.com:3777");
  });

  it("falls back to the server URL when no public URL is set", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    expect(resolveBrowserServerOrigin()).toBe("http://server:3777");
  });

  it("strips a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "https://api.example.com/");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(resolveBrowserServerOrigin()).toBe("https://api.example.com");
  });
});

describe("resolveServerOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the local server", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(resolveServerOrigin()).toBe("http://127.0.0.1:3777");
  });

  it("prefers NETPRO_SERVER_URL (the Docker compose hostname)", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "http://127.0.0.1:3777");
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    expect(resolveServerOrigin()).toBe("http://server:3777");
  });

  it("falls back to the public URL when no server URL is set", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "https://api.example.com");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(resolveServerOrigin()).toBe("https://api.example.com");
  });
});

describe("connectSrcDirective", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps 'self' and adds the loopback default", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(connectSrcDirective()).toBe("'self' http://127.0.0.1:3777");
  });

  it("adds the configured public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "https://api.example.com");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(connectSrcDirective()).toBe(
      "'self' http://127.0.0.1:3777 https://api.example.com",
    );
  });

  it("adds a differing runtime server origin too (Docker/compose split)", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "http://127.0.0.1:3777");
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    expect(connectSrcDirective()).toBe(
      "'self' http://127.0.0.1:3777 http://server:3777",
    );
  });

  it("dedupes and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "http://127.0.0.1:3777/");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    expect(connectSrcDirective()).toBe("'self' http://127.0.0.1:3777");
  });
});
