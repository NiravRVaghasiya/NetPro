import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddPersonForm } from "./add-person-form";

describe("AddPersonForm", () => {
  it("starts collapsed behind a + Add Person button", () => {
    const html = renderToStaticMarkup(<AddPersonForm serverUrl="http://127.0.0.1:3777" />);
    expect(html).toContain("+ Add Person");
    expect(html).toContain("<button");
    // The form itself stays hidden until the button is pressed.
    expect(html).not.toContain("LinkedIn profile URL");
  });

  it("renders the empty-state path with both onboarding options", () => {
    const html = renderToStaticMarkup(
      <AddPersonForm variant="empty" serverUrl="http://127.0.0.1:3777" />,
    );
    expect(html).toContain("Build your network");
    expect(html).toContain("Add LinkedIn Profile");
    expect(html).toContain("Import Data");
    expect(html).toContain('href="/import"');
  });

  it("renders an accessible form when expanded", () => {
    const html = renderToStaticMarkup(
      <AddPersonForm defaultExpanded serverUrl="http://127.0.0.1:3777" />,
    );
    expect(html).toContain("Add to NetPro");
    // Real labels, not placeholder-only.
    expect(html).toContain("LinkedIn profile URL");
    expect(html).toContain("Name");
    expect(html).toContain('for="add-person-linkedin-url"');
    expect(html).toContain('for="add-person-name"');
    // Guidance plus a live region for validation feedback.
    expect(html).toContain("https://www.linkedin.com/in/username");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Add Person");
  });
});
