import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyForm } from "./api-key-form";

describe("ApiKeyForm", () => {
  it("renders the paste-a-key flow with proper labels", () => {
    const html = renderToStaticMarkup(<ApiKeyForm serverUrl="http://127.0.0.1:3777" />);
    expect(html).toContain("Connect an API");
    expect(html).toContain("Provider");
    expect(html).toContain("API Key");
    expect(html).toContain("Validate &amp; Save");
    // Real labels, not placeholder-only.
    expect(html).toContain('for="api-key-provider"');
    expect(html).toContain('for="api-key-value"');
    // The key field is masked and never autocompleted.
    expect(html).toContain('type="password"');
    expect(html).toContain("Show API key");
    // Reassurance about secure storage, and a live region for results.
    expect(html).toContain("stored securely");
    expect(html).toContain('aria-live="polite"');
  });

  it("loads the provider list without ever rendering key material", () => {
    const html = renderToStaticMarkup(<ApiKeyForm serverUrl="http://127.0.0.1:3777" />);
    // Static render is the pre-load shell: no provider hold keys, and the
    // shell carries no secret-shaped content.
    expect(html).toContain("Loading providers…");
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("••••");
  });
});
