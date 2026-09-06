import { describe, it, expect } from "vitest";
import { buildOutreachMessages } from "./prompt";
import type { ComposeOutreachInput } from "./prompt";

const baseInput: ComposeOutreachInput = {
  recipient: {
    name: "Jane Doe",
    role: "Senior Engineer",
    company: "Stripe",
    headline: "Payments infrastructure",
    industry: "Fintech",
    location: "Berlin",
    email: "jane@stripe.com",
    linkedinUrl: "https://linkedin.com/in/jane",
    githubUrl: "https://github.com/jane",
    notes: "Met at a meetup in 2025.",
  },
  senderName: "Alex Rivera",
  tone: "warm",
  context: "We chatted after her WASM talk at React Conf.",
  purpose: "A 15-minute call about an open-source collaboration.",
};

describe("buildOutreachMessages", () => {
  it("produces a system + user pair with house rules", () => {
    const messages = buildOutreachMessages(baseInput);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");

    const system = messages[0]!.content;
    expect(system).toMatch(/never invent meetings/i);
    expect(system).toMatch(/JSON/);
  });

  it("includes every provided recipient fact and the request parameters", () => {
    const user = buildOutreachMessages(baseInput)[1]!.content;
    expect(user).toContain("Jane Doe");
    expect(user).toContain("Senior Engineer");
    expect(user).toContain("Stripe");
    expect(user).toContain("Payments infrastructure");
    expect(user).toContain("Fintech");
    expect(user).toContain("Berlin");
    expect(user).toContain("jane@stripe.com");
    expect(user).toContain("linkedin.com/in/jane");
    expect(user).toContain("github.com/jane");
    expect(user).toContain("Met at a meetup");
    expect(user).toContain("Tone: warm");
    expect(user).toContain("Sign off as: Alex Rivera");
    expect(user).toContain("React Conf");
    expect(user).toContain("open-source collaboration");
  });

  it("omits unknown fields and defaults the tone", () => {
    const messages = buildOutreachMessages({
      recipient: { name: "John" },
      senderName: "Alex",
    });
    const user = messages[1]!.content;
    expect(user).toContain("John");
    expect(user).not.toContain("Company");
    expect(user).toContain("Tone: professional");
  });

  it("tells the model to stay generic when no profile facts exist", () => {
    const user = buildOutreachMessages({ recipient: {} })[1]!.content;
    expect(user).toMatch(/no profile details/i);
  });
});
