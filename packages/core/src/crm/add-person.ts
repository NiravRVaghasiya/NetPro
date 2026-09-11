// packages/core/src/crm/add-person.ts
//
// Add-a-person from a single LinkedIn profile URL: the one domain
// implementation behind the Web UI's "Add Person" flow and
// `POST /api/contacts`.
//
// Flow: parse + normalize the URL (`import/linkedin-url`, the single
// validator — this module never reimplements URL rules) → look for an
// existing contact with the same profile (case-insensitive slug match, so a
// stored `https://linkedin.com/in/jane` matches a pasted
// `https://www.linkedin.com/in/Jane/?trk=…`) → return `{ status: "exists" }`
// instead of silently duplicating, or insert a new contact with
// `source: "linkedin_url"`.
//
// The new contact carries the normalized URL immediately and whatever name
// the caller supplied; with a bare URL the slug is humanized into a
// placeholder (`john-doe` → "John Doe") the owner can correct later. NetPro
// performs no LinkedIn profile retrieval or scraping — there is nothing to
// fetch, so there is no "Update Profile" enrichment path either.

import { randomUUID } from "node:crypto";
import { and, isNotNull, isNull } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  linkedinSlugToName,
  parseLinkedInProfileUrl,
  sameLinkedInProfile,
  LinkedInUrlError,
  type LinkedInProfileRef,
} from "../import/linkedin-url";
import type { ContactRef } from "../ai/resolve-contact";
import {
  resolveScope,
  workspacePredicate,
  type WorkspaceScope,
} from "../workspaces/scope";
import { CrmError, resolveNow, type CrmOptions } from "./types";
import { writeActivityLog } from "./activity";

/** Source tag for contacts created from a single pasted profile URL. */
export const LINKEDIN_URL_SOURCE = "linkedin_url";

/** Display-name cap for the optional caller-supplied name. */
export const ADD_PERSON_NAME_MAX = 200;

export interface AddPersonFromLinkedInInput {
  /** Pasted LinkedIn profile URL (any accepted form — see `linkedin-url`). */
  linkedinUrl: string;
  /** Optional display name; the slug is humanized when omitted. */
  fullName?: string;
}

export interface AddPersonContact {
  id: string;
  fullName: string;
  linkedinUrl: string | null;
}

export type AddPersonStatus = "created" | "exists";

export interface AddPersonResult {
  status: AddPersonStatus;
  contact: AddPersonContact;
  profile: LinkedInProfileRef;
}

export interface LinkedInImportCheck {
  profile: LinkedInProfileRef;
  /** The known contact when this profile is already in the network. */
  existing: AddPersonContact | null;
}

export type AddPersonOptions = CrmOptions;

function invalidInput(message: string): CrmError {
  return new CrmError("invalid_input", message);
}

function parseOrThrow(linkedinUrl: string): LinkedInProfileRef {
  try {
    return parseLinkedInProfileUrl(linkedinUrl);
  } catch (error) {
    if (error instanceof LinkedInUrlError) {
      throw invalidInput(error.message);
    }
    throw error;
  }
}

function normalizeName(fullName: string | undefined): string | undefined {
  if (fullName === undefined) return undefined;
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  if (trimmed === "") {
    throw invalidInput("A name can't be blank — leave it out to use the LinkedIn profile name.");
  }
  if (trimmed.length > ADD_PERSON_NAME_MAX) {
    throw invalidInput(`"fullName" must be ${ADD_PERSON_NAME_MAX} characters or fewer.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw invalidInput("That name contains unsupported characters.");
  }
  return trimmed;
}

type LinkedInCandidate = { id: string; fullName: string; linkedinUrl: string | null };

async function listLinkedInCandidates(
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<LinkedInCandidate[]> {
  // Normalization-insensitive matching (case, host, query) is pure JS over
  // the workspace's LinkedIn-bearing contacts — one portable query, no
  // dialect-specific string SQL. Contact counts are small (a personal
  // network), so scanning the URL column beats maintaining a second index.
  if (conn.dialect === "sqlite") {
    const c = conn.schema.contacts;
    return conn.db
      .select({ id: c.id, fullName: c.fullName, linkedinUrl: c.linkedinUrl })
      .from(c)
      .where(
        and(
          isNull(c.deletedAt),
          isNotNull(c.linkedinUrl),
          workspacePredicate(scope, c.workspaceId),
        ),
      );
  }
  const c = conn.schema.contacts;
  return conn.db
    .select({ id: c.id, fullName: c.fullName, linkedinUrl: c.linkedinUrl })
    .from(c)
    .where(
      and(
        isNull(c.deletedAt),
        isNotNull(c.linkedinUrl),
        workspacePredicate(scope, c.workspaceId),
      ),
    );
}

/**
 * Validate a pasted URL and report whether the profile is already known —
 * the dry-run behind the UI's "Checking profile…" state. Never writes.
 */
export async function checkLinkedInImport(
  conn: SqliteConn | PgConn,
  linkedinUrl: string,
  scope?: WorkspaceScope,
): Promise<LinkedInImportCheck> {
  const profile = parseOrThrow(linkedinUrl);
  const candidates = await listLinkedInCandidates(conn, scope);
  const match = candidates.find(
    (c) => c.linkedinUrl !== null && sameLinkedInProfile(c.linkedinUrl, profile.normalizedUrl),
  );
  return {
    profile,
    existing: match
      ? { id: match.id, fullName: match.fullName, linkedinUrl: match.linkedinUrl }
      : null,
  };
}

/**
 * Add a person from a LinkedIn profile URL, or return the existing contact
 * when the profile is already in the network (never a silent duplicate).
 */
export async function addPersonFromLinkedIn(
  conn: SqliteConn | PgConn,
  input: AddPersonFromLinkedInInput,
  scope?: WorkspaceScope,
  opts: AddPersonOptions = {},
): Promise<AddPersonResult> {
  const profile = parseOrThrow(input.linkedinUrl);
  const name = normalizeName(input.fullName);

  const candidates = await listLinkedInCandidates(conn, scope);
  const match = candidates.find(
    (c) => c.linkedinUrl !== null && sameLinkedInProfile(c.linkedinUrl, profile.normalizedUrl),
  );
  if (match) {
    return {
      status: "exists",
      contact: { id: match.id, fullName: match.fullName, linkedinUrl: match.linkedinUrl },
      profile,
    };
  }

  const now = resolveNow(opts).toISOString();
  const resolved = resolveScope(scope);
  const id = randomUUID();
  const fullName = name ?? linkedinSlugToName(profile.username);
  const values = {
    id,
    workspaceId: resolved.workspaceId,
    fullName,
    firstName: fullName.split(" ")[0] ?? fullName,
    lastName: fullName.split(" ").slice(1).join(" ") || null,
    linkedinUrl: profile.normalizedUrl,
    source: LINKEDIN_URL_SOURCE,
    createdAt: now,
    updatedAt: now,
  };

  if (conn.dialect === "sqlite") {
    await conn.db.insert(conn.schema.contacts).values(values);
  } else {
    await conn.db.insert(conn.schema.contacts).values(values);
  }

  await writeActivityLog(
    conn,
    {
      action: "contact.created",
      entityType: "contact",
      entityId: id,
      metadata: { source: LINKEDIN_URL_SOURCE },
    },
    scope,
  );

  // Keep keyword search in step, best-effort like the CSV import: an
  // unmigrated index must not fail the add.
  try {
    const { reindexSearchIndex } = await import("../search/indexer");
    await reindexSearchIndex(conn, { contactIds: [id] }, scope);
  } catch {
    // Search falls back to the portable engine until `netpro reindex` runs.
  }

  return {
    status: "created",
    contact: { id, fullName, linkedinUrl: profile.normalizedUrl },
    profile,
  };
}

export type { ContactRef };
