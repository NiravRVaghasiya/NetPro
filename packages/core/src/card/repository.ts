import { eq } from "drizzle-orm";
import type { PgConn, SqliteConn } from "@netpro/db";
import type { ProfileCard, ProfileCardState } from "./types";
import { parseProfileCardJson, validateProfileCard } from "./validation";

type Conn = SqliteConn | PgConn;
const CARD_ID = "default";
type StoredCard = {
  draft: string;
  published: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

function state(row: StoredCard | undefined): ProfileCardState {
  return {
    draft: row ? parseProfileCardJson(row.draft) : null,
    published: row?.published ? parseProfileCardJson(row.published) : null,
    publishedAt: row?.publishedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Private editor only — this includes unpublished data. */
export async function getProfileCardState(
  conn: Conn,
): Promise<ProfileCardState> {
  // Narrow the union so Drizzle's overloaded dialect-specific builders remain typed.
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .select()
          .from(conn.schema.profileCards)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .limit(1)
      : await conn.db
          .select()
          .from(conn.schema.profileCards)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .limit(1);
  return state(rows[0]);
}

/** Public allowlist: never select the draft, contacts, auth data, or private state. */
export async function getPublishedCard(
  conn: Conn,
): Promise<ProfileCard | null> {
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .select({ published: conn.schema.profileCards.published })
          .from(conn.schema.profileCards)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .limit(1)
      : await conn.db
          .select({ published: conn.schema.profileCards.published })
          .from(conn.schema.profileCards)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .limit(1);
  const published = rows[0]?.published;
  return published ? parseProfileCardJson(published) : null;
}

async function writeProfile(
  conn: Conn,
  input: unknown,
  publish: boolean,
  now: Date,
): Promise<ProfileCardState> {
  const draft = JSON.stringify(validateProfileCard(input));
  const updatedAt = now.toISOString();
  // A draft save intentionally omits published fields from the UPDATE set.
  const changes = {
    draft,
    updatedAt,
    ...(publish ? { published: draft, publishedAt: updatedAt } : {}),
  };
  const values = { id: CARD_ID, ...changes };
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .insert(conn.schema.profileCards)
          .values(values)
          .onConflictDoUpdate({
            target: conn.schema.profileCards.id,
            set: changes,
          })
          .returning()
      : await conn.db
          .insert(conn.schema.profileCards)
          .values(values)
          .onConflictDoUpdate({
            target: conn.schema.profileCards.id,
            set: changes,
          })
          .returning();
  return state(rows[0]);
}

export function saveProfileDraft(
  conn: Conn,
  input: unknown,
  now = new Date(),
): Promise<ProfileCardState> {
  return writeProfile(conn, input, false, now);
}

/** One upsert publishes and saves the same snapshot; no read/modify/write race. */
export function publishProfileCard(
  conn: Conn,
  input: unknown,
  now = new Date(),
): Promise<ProfileCardState> {
  return writeProfile(conn, input, true, now);
}

export async function unpublishProfileCard(
  conn: Conn,
  now = new Date(),
): Promise<ProfileCardState> {
  const changes = {
    published: null,
    publishedAt: null,
    updatedAt: now.toISOString(),
  };
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .update(conn.schema.profileCards)
          .set(changes)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .returning()
      : await conn.db
          .update(conn.schema.profileCards)
          .set(changes)
          .where(eq(conn.schema.profileCards.id, CARD_ID))
          .returning();
  return state(rows[0]);
}
