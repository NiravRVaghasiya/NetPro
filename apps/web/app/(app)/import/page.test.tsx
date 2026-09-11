vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson: async () => {
    throw new Error("server down");
  },
}));

vi.mock("@/hooks/use-netpro-events", () => ({
  useNetProEvents: () => ({
    events: [],
    connected: false,
    error: null,
    lastEvent: null,
    clear: () => {},
  }),
}));

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ImportPage from "./page";

describe("Import page (Phase 15)", () => {
  it("renders the Upload → Preview → Validate → Import flow", () => {
    const html = renderToStaticMarkup(<ImportPage /> as unknown as React.ReactElement);
    expect(html).toContain("Import");
    expect(html).toContain("1 · Upload");
    expect(html).toContain("LinkedIn connections CSV");
    expect(html).toContain("netpro import linkedin.csv");
  });
});
