import { describe, it, expect, vi } from "vitest";
import {
  createOpenAiProvider,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
} from "./openai";
import { AiProviderError } from "../types";

function fakeFetch(
  response:
    | Partial<Response>
    | ((url: string, init?: RequestInit) => Partial<Response>),
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const r = typeof response === "function" ? response(url, init) : response;
    return { ok: true, status: 200, json: async () => ({}), ...r } as Response;
  });
}

describe("createOpenAiProvider", () => {
  it("posts a chat completion and extracts the reply text", async () => {
    const fetchImpl = fakeFetch({
      json: async () => ({
        choices: [{ message: { content: "Hello there" } }],
      }),
    });
    const provider = createOpenAiProvider({ apiKey: "sk-test" }, fetchImpl);

    const reply = await provider.complete(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      { model: "gpt-custom" },
    );

    expect(reply).toBe("Hello there");
    expect(provider.id).toBe("openai");
    expect(provider.defaultModel).toBe(OPENAI_DEFAULT_MODEL);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${OPENAI_DEFAULT_BASE_URL}/chat/completions`);
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body).toMatchObject({
      model: "gpt-custom",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.7,
      max_tokens: 600,
    });
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
  });

  it("uses the default model and a baseUrl override", async () => {
    const fetchImpl = fakeFetch({
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    const provider = createOpenAiProvider(
      {
        apiKey: "k",
        baseUrl: "https://gateway.example.com/v1/",
        model: "gpt-4o",
      },
      fetchImpl,
    );
    await provider.complete([{ role: "user", content: "x" }]);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.com/v1/chat/completions");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.model).toBe("gpt-4o"); // config default wins over built-in
  });

  it("passes through option overrides", async () => {
    const fetchImpl = fakeFetch({
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    const provider = createOpenAiProvider({ apiKey: "k" }, fetchImpl);
    await provider.complete([{ role: "user", content: "x" }], {
      temperature: 0.2,
      maxTokens: 100,
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1]?.body as string) ?? "{}",
    );
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100);
  });

  it("throws an upstream_error with status and provider message on failure", async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "bad api key" } }),
    });
    const provider = createOpenAiProvider({ apiKey: "nope" }, fetchImpl);
    await expect(
      provider.complete([{ role: "user", content: "x" }]),
    ).rejects.toMatchObject({
      code: "upstream_error",
    });
    await expect(
      provider.complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/OpenAI request failed: 401 bad api key/);
  });

  it("throws invalid_response on an empty completion", async () => {
    const fetchImpl = fakeFetch({ json: async () => ({ choices: [] }) });
    const provider = createOpenAiProvider({ apiKey: "k" }, fetchImpl);
    await expect(
      provider.complete([{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(AiProviderError);
    await expect(
      provider.complete([{ role: "user", content: "x" }]),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
