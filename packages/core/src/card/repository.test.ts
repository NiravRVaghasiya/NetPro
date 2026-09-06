import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import {
  getProfileCardState,
  getPublishedCard,
  publishProfileCard,
  saveProfileDraft,
  unpublishProfileCard,
} from "./repository";

const profile = { fullName: "Ada", email: "public@example.com" };
const now = new Date("2026-09-06T12:00:00Z");

describe("profile card repository (real SQLite migrations)", () => {
  let fixture: ReturnType<typeof createTestSqliteConn>;
  beforeEach(() => {
    fixture = createTestSqliteConn();
  });
  afterEach(() => {
    fixture.sqlite.close();
  });

  it("starts private and empty; saving a draft never publishes", async () => {
    const { conn } = fixture;
    expect(await getProfileCardState(conn)).toEqual({
      draft: null,
      published: null,
      publishedAt: null,
      updatedAt: null,
    });
    const saved = await saveProfileDraft(conn, profile, now);
    expect(saved.draft).toMatchObject(profile);
    expect(saved.updatedAt).toBe(now.toISOString());
    expect(await getPublishedCard(conn)).toBeNull();
  });

  it("publishes atomically; subsequent private edits don't change public data", async () => {
    const { conn } = fixture;
    const published = await publishProfileCard(conn, profile, now);
    expect(published.draft).toEqual(published.published);
    expect(published.publishedAt).toBe(now.toISOString());
    const later = new Date("2026-09-06T13:00:00Z");
    await saveProfileDraft(
      conn,
      { fullName: "Private draft", email: "private@example.com" },
      later,
    );
    expect(await getPublishedCard(conn)).toMatchObject(profile);
    const state = await getProfileCardState(conn);
    expect(state.draft?.email).toBe("private@example.com");
    expect(state.publishedAt).toBe(now.toISOString());
    expect(state.updatedAt).toBe(later.toISOString());
  });

  it("unpublishes immediately, retains edits, and supports republishing", async () => {
    const { conn } = fixture;
    await publishProfileCard(conn, profile, now);
    await saveProfileDraft(conn, { fullName: "Next version" }, now);
    const hidden = await unpublishProfileCard(conn, now);
    expect(hidden.published).toBeNull();
    expect(hidden.publishedAt).toBeNull();
    expect(hidden.draft?.fullName).toBe("Next version");
    expect(await getPublishedCard(conn)).toBeNull();
    await publishProfileCard(conn, hidden.draft, now);
    expect((await getPublishedCard(conn))?.fullName).toBe("Next version");
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM profile_cards").get(),
    ).toEqual({ n: 1 });
  });

  it("unpublishing an absent or already-private card is idempotent", async () => {
    const { conn } = fixture;
    expect((await unpublishProfileCard(conn)).draft).toBeNull();
    await saveProfileDraft(conn, profile, now);
    await unpublishProfileCard(conn);
    await unpublishProfileCard(conn);
    expect(await getPublishedCard(conn)).toBeNull();
    expect((await getProfileCardState(conn)).draft).toMatchObject(profile);
  });

  it("validates before writing and does not damage an existing publication", async () => {
    const { conn } = fixture;
    await publishProfileCard(conn, profile, now);
    await expect(publishProfileCard(conn, { fullName: "" })).rejects.toThrow(
      /fullName/,
    );
    await expect(
      saveProfileDraft(conn, { ...profile, notes: "private" }),
    ).rejects.toThrow(/unsupported/);
    expect(await getPublishedCard(conn)).toMatchObject(profile);
  });

  it("does not read draft JSON or private tables through the public loader", async () => {
    const { conn, sqlite } = fixture;
    await publishProfileCard(conn, profile, now);
    sqlite
      .prepare("UPDATE profile_cards SET draft = ?")
      .run("not even valid JSON");
    expect(await getPublishedCard(conn)).toMatchObject(profile);
    for (const table of ["contacts", "profile_views", "interactions"]) {
      expect(
        sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    }
  });
});
