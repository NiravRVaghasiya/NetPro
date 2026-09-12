// apps/web/lib/netpro-server.test.ts
//
// Pins where browser-side requests point in each mode. In development the
// browser uses same-origin `/api/*` paths (proxied by the Next.js dev server
// to the NetPro server), so it never dials 127.0.0.1 from the viewer's
// machine; in production it uses the absolute origin (baked public URL or the
// loopback default), which the page's connect-src policy permits.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventsUrl, getServerUrl, isLoopbackServerUrl } from "./netpro-server";

function stubServerUrlEnv(): void {
  vi.stubEnv("NETPRO_SERVER_URL", "");
  vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
}

describe("getServerUrl (Node / server render)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("defaults to the local server when nothing is configured", () => {
    stubServerUrlEnv();
    expect(getServerUrl()).toBe("http://127.0.0.1:3777");
  });

  it("prefers NETPRO_SERVER_URL for server-rendered requests", () => {
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    expect(getServerUrl()).toBe("http://server:3777");
  });
});

describe("getServerUrl (browser)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses a same-origin relative base in development", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    stubServerUrlEnv();
    expect(getServerUrl()).toBe("");
  });

  it("keeps the loopback default in production", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "production");
    stubServerUrlEnv();
    expect(getServerUrl()).toBe("http://127.0.0.1:3777");
  });

  it("honours an explicit public server URL in any mode", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NETPRO_SERVER_URL", "");
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "https://api.example.com:3777");
    expect(getServerUrl()).toBe("https://api.example.com:3777");
  });
});

describe("isLoopbackServerUrl", () => {
  it("treats a relative base as the trusted same-origin path", () => {
    expect(isLoopbackServerUrl("")).toBe(true);
  });

  it("recognises loopback origins", () => {
    expect(isLoopbackServerUrl("http://127.0.0.1:3777")).toBe(true);
    expect(isLoopbackServerUrl("http://localhost:3000")).toBe(true);
  });

  it("rejects remote origins", () => {
    expect(isLoopbackServerUrl("https://api.example.com")).toBe(false);
  });
});

describe("getEventsUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a relative SSE URL in the browser during development", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    stubServerUrlEnv();
    expect(getEventsUrl({ history: "20" })).toBe("/api/events?history=20");
  });

  it("builds an absolute SSE URL on the server", () => {
    vi.stubEnv("NETPRO_SERVER_URL", "http://server:3777");
    vi.stubEnv("NEXT_PUBLIC_NETPRO_SERVER_URL", "");
    expect(getEventsUrl()).toBe("http://server:3777/api/events");
  });
});
