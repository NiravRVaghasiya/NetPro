import { describe, expect, it } from "vitest";
import { isSameOriginRequest, readCardRequest } from "./card-request";

function request(headers: Record<string, string>) {
  return new Request("https://netpro.example/api/card", {
    method: "PUT",
    headers,
  });
}

describe("card mutation origin checks", () => {
  it("accepts a normal browser request", () => {
    expect(
      isSameOriginRequest(request({ origin: "https://netpro.example" })),
    ).toBe(true);
  });
  it.each<Record<string, string>>([
    { origin: "null" },
    { origin: "not a URL" },
    { origin: "http://netpro.example" },
    { origin: "https://netpro.example.attacker.com" },
    { origin: "https://user@netpro.example" },
    { origin: "https://netpro.example/path" },
    { origin: "https://netpro.example", "sec-fetch-site": "cross-site" },
    {
      origin: "https://netpro.example",
      "x-forwarded-host": "netpro.example, attacker.example",
    },
    { origin: "https://netpro.example", "x-forwarded-proto": "https,http" },
  ])("rejects mismatched, malformed, or ambiguous headers: %j", (headers) => {
    expect(isSameOriginRequest(request(headers))).toBe(false);
  });
});

describe("card body reader", () => {
  it("accepts JSON with a charset", async () => {
    const req = new Request("https://netpro.example/api/card", {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"fullName":"Ada"}',
    });
    expect((await readCardRequest(req)).fullName).toBe("Ada");
  });
  it("rejects an absent body and invalid UTF-8", async () => {
    await expect(
      readCardRequest(request({ "content-type": "application/json" })),
    ).rejects.toMatchObject({ status: 400 });
    const req = new Request("https://netpro.example/api/card", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff, 0xfe]),
    });
    await expect(readCardRequest(req)).rejects.toMatchObject({ status: 400 });
  });
});
