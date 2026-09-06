import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getProfileCardState,
  publishProfileCard,
  saveProfileDraft,
  unpublishProfileCard,
} from "@netpro/core/src/card/repository";
import { validateProfileCard } from "@netpro/core/src/card/validation";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
import PublicCardPage, { generateMetadata } from "./page";
import { GET as download } from "./vcard/route";
import { ProfileCardView } from "@/components/profile-card";
import CardEditor from "../(app)/settings/card/editor";

const { conn } = fixture;
const profile = {
  fullName: "Public Ada",
  headline: "A public introduction",
  email: "public@example.com",
};
beforeEach(async () => {
  await conn.db.delete(conn.schema.profileCards);
});
afterAll(() => fixture.sqlite.close());

describe("public card boundary", () => {
  it("does not expose an absent card or a saved-but-unpublished draft", async () => {
    await expect(PublicCardPage()).rejects.toThrow("NOT_FOUND");
    expect((await download()).status).toBe(404);
    await saveProfileDraft(conn, {
      fullName: "SECRET DRAFT",
      email: "secret@example.com",
    });
    await expect(PublicCardPage()).rejects.toThrow("NOT_FOUND");
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("Card unavailable — NetPro");
    expect(JSON.stringify(metadata)).not.toContain("SECRET");
    const response = await download();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("serves only the published snapshot in HTML, metadata, and vCard", async () => {
    await publishProfileCard(conn, profile);
    await saveProfileDraft(conn, {
      fullName: "SECRET DRAFT",
      email: "secret@example.com",
      bio: "Private notes",
    });
    const html = renderToStaticMarkup(await PublicCardPage());
    expect(html).toContain("Public Ada");
    expect(html).toContain('href="/card/vcard"');
    const metadata = await generateMetadata();
    expect(metadata).toMatchObject({
      title: "Public Ada — NetPro",
      description: "A public introduction",
      robots: { index: false, follow: false },
      referrer: "no-referrer",
      openGraph: {
        title: "Public Ada — NetPro",
        description: "A public introduction",
      },
    });
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/vcard; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="contact.vcf"',
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(body).toContain("FN:Public Ada");
    for (const output of [html, JSON.stringify(metadata), body]) {
      expect(output).not.toMatch(/SECRET|secret@example|Private notes/);
    }
  });

  it("does not serve stale publications after unpublishing", async () => {
    await publishProfileCard(conn, profile);
    await PublicCardPage();
    await unpublishProfileCard(conn);
    await expect(PublicCardPage()).rejects.toThrow("NOT_FOUND");
    expect((await download()).status).toBe(404);
    expect((await generateMetadata()).title).toBe("Card unavailable — NetPro");
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM profile_views").get(),
    ).toEqual({ n: 0 });
  });

  it("escapes React content and refuses unsafe preview links", () => {
    const data = validateProfileCard({
      fullName: '<script>alert("hello")</script>',
    });
    const html = renderToStaticMarkup(
      <ProfileCardView
        profile={{
          ...data,
          links: [{ label: "Unsafe", url: "javascript:alert(1)" }],
        }}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
  });

  it("renders the private editor with explicit consent and private-by-default copy", async () => {
    const html = renderToStaticMarkup(
      <CardEditor initialState={await getProfileCardState(conn)} />,
    );
    expect(html).toContain("Private preview");
    expect(html).toContain("Save draft");
    expect(html).toContain("Publish card");
    expect(html).toContain("Private · not published");
    expect(html).toContain("I’ve reviewed the preview");
    expect(html).toContain("Download profile JSON");
  });
});
