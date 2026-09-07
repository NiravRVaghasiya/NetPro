// packages/core/src/skills/repository.ts
//
// v2.0 Phase 5 — the database side of skills.
//
// Storage decision (plan §Phase 5, "Recommendation: both"):
//   * the VERDICT lives on the contact — `contacts.skills`, a JSON array of
//     canonical taxonomy names, cheap to read and filter (search joins it);
//   * the EVIDENCE lives in `enrichments` — one row per (contact, provider)
//     with `provider = 'skills_heuristic' | 'skills_ai'`, `data_type =
//     'skills'`, and the full extraction (skills, per-skill evidence
//     snippets, confidence) as the payload. Re-running replaces the row, so
//     the table never grows past one row per contact per extractor.
//
// Source fields (headline, notes, tags…) are never modified. Every write is
// idempotent: an unchanged verdict is a no-op (`changed: false`), and
// `updatedAt` only moves when the verdict actually changes.
//
// Reads are raw ANSI SQL through the same `rawAll` helper the search indexer
// uses — one query text for both dialects, no per-dialect duplication.

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { writeActivityLog } from '../crm/activity';
import type { AiProvider } from '../ai/types';
import { rawAll, reindexSearchIndex } from '../search/indexer';
import {
  extractSkills,
  extractSkillsWithAi,
  storedSkills,
  type SkillContact,
  type SkillExtraction,
} from './extract';
import type { SkillContactRef } from './gap';
import type { Skill } from './taxonomy';

type Conn = SqliteConn | PgConn;

export const SKILLS_PROVIDER_HEURISTIC = 'skills_heuristic';
export const SKILLS_PROVIDER_AI = 'skills_ai';
export const SKILLS_DATA_TYPE = 'skills';

/** A live contact with the fields both extraction and ranking need. */
export interface SkillContactRow extends SkillContact, SkillContactRef {
  company: string | null;
  role: string | null;
  relationshipScore: number | null;
  updatedAt: string;
}

/** Hard cap on one load — the analysis is in-memory and this is a single-owner tool. */
export const SKILL_CONTACT_LIMIT = 10_000;

interface ContactSqlRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  email: string | null;
  headline: string | null;
  role: string | null;
  company: string | null;
  department: string | null;
  industry: string | null;
  notes: string | null;
  tags: unknown;
  custom_fields: unknown;
  skills: unknown;
  relationship_score: number | string | null;
  updated_at: string;
}

function toRow(r: ContactSqlRow): SkillContactRow {
  const score = r.relationship_score === null ? null : Number(r.relationship_score);
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    headline: r.headline,
    role: r.role,
    company: r.company,
    department: r.department,
    industry: r.industry,
    notes: r.notes,
    tags: r.tags,
    customFields: r.custom_fields,
    skills: r.skills,
    relationshipScore: score !== null && Number.isFinite(score) ? score : null,
    updatedAt: r.updated_at,
  };
}

/** Every live contact (soft-deleted excluded), ordered by id for determinism. */
export async function loadSkillContacts(conn: Conn, opts: { ids?: string[] } = {}): Promise<SkillContactRow[]> {
  const ids = opts.ids?.map((id) => id.trim()).filter((id) => id !== '');
  if (opts.ids && (!ids || ids.length === 0)) return [];
  const scope = ids ? sql` AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = await rawAll<ContactSqlRow>(
    conn,
    sql`SELECT id, full_name, email, headline, role, company, department, industry, notes,
               tags, custom_fields, skills, relationship_score, updated_at
        FROM contacts
        WHERE deleted_at IS NULL${scope}
        ORDER BY id
        LIMIT ${SKILL_CONTACT_LIMIT}`,
  );
  return rows.map(toRow);
}

/** One live contact by id, or null. */
export async function getSkillContact(conn: Conn, contactId: string): Promise<SkillContactRow | null> {
  const rows = await loadSkillContacts(conn, { ids: [contactId] });
  return rows[0] ?? null;
}

function sameSkills(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

export interface WriteSkillsResult {
  contactId: string;
  skills: Skill[];
  /** False when the stored verdict already matched (no contact write happened). */
  changed: boolean;
}

/**
 * Persist the verdict on the contact and the evidence in `enrichments`.
 * Idempotent: same skills → no contact write, but the evidence row is still
 * refreshed so `fetched_at` reflects the last run.
 */
export async function writeExtractedSkills(
  conn: Conn,
  contactId: string,
  extraction: SkillExtraction,
  opts: { now?: Date; previous?: unknown } = {},
): Promise<WriteSkillsResult> {
  const now = (opts.now ?? new Date()).toISOString();
  let previous = opts.previous;
  if (previous === undefined) {
    const rows = await rawAll<{ skills: unknown }>(conn, sql`SELECT skills FROM contacts WHERE id = ${contactId}`);
    previous = rows[0]?.skills ?? null;
  }
  const before = storedSkills(previous);
  const changed = !sameSkills(before, extraction.skills);

  if (changed) {
    // SQLite's column is json-mode (array in); Postgres's is plain text (stringified in).
    if (conn.dialect === 'sqlite') {
      await conn.db
        .update(conn.schema.contacts)
        .set({ skills: extraction.skills, updatedAt: now })
        .where(eq(conn.schema.contacts.id, contactId));
    } else {
      await conn.db
        .update(conn.schema.contacts)
        .set({ skills: JSON.stringify(extraction.skills), updatedAt: now })
        .where(eq(conn.schema.contacts.id, contactId));
    }
  }

  const provider = extraction.mode === 'ai' ? SKILLS_PROVIDER_AI : SKILLS_PROVIDER_HEURISTIC;
  const payload = {
    skills: extraction.skills,
    details: extraction.details,
    mode: extraction.mode,
    ...(extraction.aiError ? { aiError: extraction.aiError } : {}),
  };
  const confidence = extraction.details.length
    ? Math.round((extraction.details.reduce((s, d) => s + d.confidence, 0) / extraction.details.length) * 100) / 100
    : 1;
  const row = {
    id: randomUUID(),
    contactId,
    provider,
    dataType: SKILLS_DATA_TYPE,
    confidence,
    fetchedAt: now,
    expiresAt: null,
    stale: false,
  };
  if (conn.dialect === 'sqlite') {
    const e = conn.schema.enrichments;
    await conn.db.delete(e).where(and(eq(e.contactId, contactId), eq(e.provider, provider)));
    await conn.db.insert(e).values({ ...row, rawPayload: payload });
  } else {
    const e = conn.schema.enrichments;
    await conn.db.delete(e).where(and(eq(e.contactId, contactId), eq(e.provider, provider)));
    await conn.db.insert(e).values({ ...row, rawPayload: JSON.stringify(payload) });
  }

  if (changed) {
    await writeActivityLog(conn, {
      action: 'skills.extracted',
      entityType: 'contact',
      entityId: contactId,
      metadata: { mode: extraction.mode, skills: extraction.skills, before },
    });
  }
  return { contactId, skills: extraction.skills, changed };
}

export interface SkillsEvidenceRow {
  provider: string;
  fetchedAt: string;
  confidence: number | null;
  payload: { skills: Skill[]; details: SkillExtraction['details']; mode: SkillExtraction['mode']; aiError?: string };
}

/** The stored evidence rows for a contact (heuristic and/or AI), newest first. */
export async function getSkillsEvidence(conn: Conn, contactId: string): Promise<SkillsEvidenceRow[]> {
  const rows = await rawAll<{ provider: string; fetched_at: string; confidence: number | string | null; raw_payload: unknown }>(
    conn,
    sql`SELECT provider, fetched_at, confidence, raw_payload
        FROM enrichments
        WHERE contact_id = ${contactId} AND data_type = ${SKILLS_DATA_TYPE}`,
  );
  return rows
    .map((r) => {
      const raw = r.raw_payload;
      let payload: SkillsEvidenceRow['payload'];
      try {
        payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as SkillsEvidenceRow['payload'];
      } catch {
        payload = { skills: [], details: [], mode: 'heuristic' };
      }
      return {
        provider: r.provider,
        fetchedAt: r.fetched_at,
        confidence: r.confidence === null ? null : Number(r.confidence),
        payload,
      };
    })
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

export interface SkillsProfile {
  contact: SkillContactRow;
  /** The persisted verdict (empty until an extraction is stored). */
  stored: Skill[];
  /** A fresh heuristic pass over the current fields — what an extraction would write today. */
  current: SkillExtraction;
  /** Stored skills the current text no longer supports (owner/AI claims). */
  unsupported: Skill[];
  evidence: SkillsEvidenceRow[];
}

/** What the contact page shows: stored verdict, fresh extraction, and the evidence trail. */
export async function getSkillsProfile(conn: Conn, contactId: string): Promise<SkillsProfile | null> {
  const contact = await getSkillContact(conn, contactId);
  if (!contact) return null;
  const stored = storedSkills(contact.skills);
  const current = extractSkills({ ...contact, skills: null });
  const evidence = await getSkillsEvidence(conn, contact.id);
  return {
    contact,
    stored,
    current,
    unsupported: stored.filter((s) => !current.skills.includes(s)),
    evidence,
  };
}

export interface ExtractBatchOptions {
  /** Restrict to these contacts (default: every live contact). */
  contactIds?: string[];
  /** `ai` runs the optional model pass on top of the heuristics (needs `provider`). */
  mode?: 'heuristic' | 'ai';
  provider?: AiProvider | null;
  model?: string;
  /** Preview only — nothing is written. */
  dryRun?: boolean;
  now?: Date;
  limit?: number;
}

export interface ExtractBatchSummary {
  scanned: number;
  /** Contacts whose stored verdict changed (or would, on `dryRun`). */
  updated: number;
  unchanged: number;
  /** Contacts with at least one skill after extraction. */
  withSkills: number;
  mode: 'heuristic' | 'ai';
  /** AI failures by contact; heuristics were still applied for these. */
  aiErrors: Array<{ contactId: string; error: string }>;
  dryRun: boolean;
  /** The first 200 changes, for review output. */
  changes: Array<{ contactId: string; fullName: string; before: Skill[]; after: Skill[] }>;
  /**
   * Search-index rows refreshed for changed contacts (the keyword arm indexes
   * the verdict). Absent when the index could not be written — an unmigrated
   * or failing index never fails an extraction, same posture as import.
   */
  indexed?: { indexed: number; skipped: number };
}

export const BATCH_CHANGES_LIMIT = 200;

/**
 * The batch producer behind `netpro skills extract` / `POST /api/skills/extract`.
 * Heuristic by default; the AI pass is opt-in per call and degrades to
 * heuristics per contact when the provider fails (recorded in `aiErrors`).
 */
export async function extractSkillsBatch(conn: Conn, opts: ExtractBatchOptions = {}): Promise<ExtractBatchSummary> {
  const mode = opts.mode === 'ai' ? 'ai' : 'heuristic';
  if (mode === 'ai' && !opts.provider) {
    throw new Error('AI extraction requested but no AI provider is configured.');
  }
  let contacts = await loadSkillContacts(conn, { ids: opts.contactIds });
  if (opts.limit && opts.limit > 0) contacts = contacts.slice(0, Math.floor(opts.limit));

  const summary: ExtractBatchSummary = {
    scanned: 0,
    updated: 0,
    unchanged: 0,
    withSkills: 0,
    mode,
    aiErrors: [],
    dryRun: Boolean(opts.dryRun),
    changes: [],
  };

  const changedIds: string[] = [];
  for (const contact of contacts) {
    summary.scanned += 1;
    const before = storedSkills(contact.skills);
    // Extract from the fields only — the stored verdict is what we are
    // recomputing, so it must not feed back into itself.
    const input: SkillContact = { ...contact, skills: null };
    const extraction =
      mode === 'ai'
        ? await extractSkillsWithAi(input, { provider: opts.provider!, model: opts.model })
        : extractSkills(input);
    if (extraction.aiError) summary.aiErrors.push({ contactId: contact.id, error: extraction.aiError });
    if (extraction.skills.length > 0) summary.withSkills += 1;

    if (sameSkills(before, extraction.skills)) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
      changedIds.push(contact.id);
      if (summary.changes.length < BATCH_CHANGES_LIMIT) {
        summary.changes.push({ contactId: contact.id, fullName: contact.fullName, before, after: extraction.skills });
      }
    }
    if (!opts.dryRun) {
      await writeExtractedSkills(conn, contact.id, extraction, { now: opts.now, previous: contact.skills });
    }
  }

  if (!opts.dryRun && changedIds.length > 0) {
    try {
      // Keyword-only: a skills run must never spend an embedding call.
      const result = await reindexSearchIndex(conn, { contactIds: changedIds });
      summary.indexed = { indexed: result.indexed, skipped: result.skipped };
    } catch {
      summary.indexed = undefined;
    }
  }
  return summary;
}

export interface SkillsStatus {
  contacts: number;
  /** Contacts with a non-empty stored verdict. */
  withSkills: number;
  /** Contacts whose stored verdict has never been written (NULL). */
  neverExtracted: number;
}

/** Cheap counts for the status line / health payload. */
export async function skillsStatus(conn: Conn): Promise<SkillsStatus> {
  const rows = await rawAll<{ contacts: unknown; with_skills: unknown; never_extracted: unknown }>(
    conn,
    sql`SELECT
          count(*) AS contacts,
          sum(CASE WHEN skills IS NOT NULL AND skills <> '[]' AND skills <> '' THEN 1 ELSE 0 END) AS with_skills,
          sum(CASE WHEN skills IS NULL THEN 1 ELSE 0 END) AS never_extracted
        FROM contacts WHERE deleted_at IS NULL`,
  );
  const row = rows[0];
  return {
    contacts: Number(row?.contacts ?? 0),
    withSkills: Number(row?.with_skills ?? 0),
    neverExtracted: Number(row?.never_extracted ?? 0),
  };
}
