import { describe, it, expect } from "vitest";
import { composeOutreachMessage, validateComposeInput } from "./compose";
import { AiProviderError, type AiProvider, type ChatMessage } from "./types";

function fakeProvider(reply: string | ((messages: ChatMessage[]) => string)): {
  provider: AiProvider;
  calls: { messages: ChatMessage[]; model?: string }[];
} {
  const calls: { messages: ChatMessage[]; model?: string }[] = [];
  const provider: AiProvider = {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-fake",
    async complete(messages, options) {
      calls.push({ messages, model: options?.model });
      return typeof reply === "function" ? reply(messages) : reply;
    },
  };
  return { provider, calls };
}

const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("composeOutreachMessage", () => {
  it("builds a draft from the provider reply with metadata", async () => {
    const { provider, calls } = fakeProvider(
      '{"subject":"Hi Jane","body":"Great talk at React Conf."}',
    );
    const draft = await composeOutreachMessage(
      {
        recipient: { name: "Jane", company: "Stripe" },
        tone: "warm",
        senderName: "Alex",
      },
      { provider, now: NOW },
    );

    expect(draft).toMatchObject({
      subject: "Hi Jane",
      body: "Great talk at React Conf.",
      provider: "openai",
      model: "gpt-fake",
      tone: "warm",
      generatedAt: NOW.toISOString(),
    });
    // The prompt was built from the recipient facts.
    const userMessage = calls[0]!.messages.find(
      (m) => m.role === "user",
    )!.content;
    expect(userMessage).toContain("Jane");
    expect(userMessage).toContain("Stripe");
  });

  it("passes an explicit model override through to the provider and draft", async () => {
    const { provider, calls } = fakeProvider("Subject: S\n\nB");
    const draft = await composeOutreachMessage(
      { recipient: { name: "Jane" }, model: "gpt-custom" },
      { provider, now: NOW },
    );
    expect(draft.model).toBe("gpt-custom");
    expect(calls[0]!.model).toBe("gpt-custom");
  });

  it("defaults the tone to professional", async () => {
    const { provider } = fakeProvider('{"subject":"S","body":"B"}');
    const draft = await composeOutreachMessage(
      { recipient: { name: "Jane" } },
      { provider, now: NOW },
    );
    expect(draft.tone).toBe("professional");
  });

  it("propagates upstream errors", async () => {
    const provider: AiProvider = {
      id: "anthropic",
      label: "Anthropic",
      defaultModel: "claude-fake",
      async complete() {
        throw new AiProviderError(
          "upstream_error",
          "Anthropic request failed: 500",
        );
      },
    };
    await expect(
      composeOutreachMessage({ recipient: { name: "Jane" } }, { provider }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("wraps unparseable replies as invalid_response", async () => {
    const { provider } = fakeProvider("the model rambled with no structure");
    await expect(
      composeOutreachMessage({ recipient: { name: "Jane" } }, { provider }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("validateComposeInput", () => {
  it("requires a name or email", () => {
    expect(() => validateComposeInput({ recipient: {} })).toThrowError(
      AiProviderError,
    );
    try {
      validateComposeInput({ recipient: {} });
      throw new Error("expected");
    } catch (e) {
      expect((e as AiProviderError).code).toBe("invalid_input");
    }
    // An email alone is enough.
    expect(validateComposeInput({ recipient: { email: "a@b.com" } }).tone).toBe(
      "professional",
    );
  });

  it("rejects unknown tones", () => {
    try {
      validateComposeInput({
        recipient: { name: "X" },
        tone: "aggressive" as never,
      });
      throw new Error("expected");
    } catch (e) {
      expect((e as AiProviderError).code).toBe("invalid_input");
      expect((e as Error).message).toMatch(
        /professional, warm, casual, friendly/,
      );
    }
  });

  it("enforces length caps", () => {
    expect(() =>
      validateComposeInput({
        recipient: { name: "X" },
        context: "a".repeat(2001),
      }),
    ).toThrow(/Context must be 2000/);
    expect(() =>
      validateComposeInput({
        recipient: { name: "X" },
        purpose: "a".repeat(501),
      }),
    ).toThrow(/Purpose must be 500/);
    expect(() =>
      validateComposeInput({ recipient: { name: "a".repeat(201) } }),
    ).toThrow(/name must be 200/);
  });

  it("validates email shape", () => {
    expect(() =>
      validateComposeInput({ recipient: { email: "not-an-email" } }),
    ).toThrow(/not a valid email/);
  });
});
