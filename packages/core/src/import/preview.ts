// packages/core/src/import/preview.ts
//
// Phase 15 — the import preview/validate step, shared by the CLI and the
// server so the Web UI's "Upload → Preview → Validate → Import" flow never
// duplicates importer logic.
//
// `analyzeImportRow` is the single normalization+validation path: `runImport`
// (pipeline.ts) and `previewImport` both call it, so what the preview marks
// invalid is exactly what the import will skip. The preview never writes to
// the database — it only parses and reports, which is what makes the "Preview"
// and "Validate" steps instant and side-effect free.

import { parseLinkedInCSV, type RawContact } from './linkedin-csv';
import {
  generateFingerprint,
  normalizeCompany,
  normalizeName,
  normalizeTitle,
  parseLinkedInDate,
  type NormalizedContact,
  type Seniority,
} from './normalize';
import type { ImportError } from './pipeline';

/** The outcome of running one CSV row through the shared normalization path. */
export type AnalyzedImportRow =
  | {
      ok: true;
      /** 1-based CSV line number (header is line 1). */
      row: number;
      contact: NormalizedContact;
      /** ISO connection date when the row carries a parseable "Connected On". */
      connectionDate?: string;
      raw: RawContact;
    }
  | { ok: false; row: number; reason: string };

/**
 * Normalize and validate a single raw contact row.
 *
 * This is the one place import correctness lives: `runImport` uses it to
 * decide insert-vs-merge-vs-skip, and `previewImport` uses it to show the
 * user what will happen before anything is written. Keeping them identical is
 * the whole point of Phase 15 ("No duplicate importer").
 */
export function analyzeImportRow(raw: RawContact, row: number): AnalyzedImportRow {
  try {
    const { firstName, lastName, fullName } = normalizeName(raw);
    if (!fullName) return { ok: false, row, reason: 'missing name' };

    const { company } = normalizeCompany(raw.company);
    const { role, seniority } = normalizeTitle(raw.position);
    const fingerprint = generateFingerprint({ email: raw.email, fullName, company });

    return {
      ok: true,
      row,
      raw,
      contact: {
        fullName,
        firstName,
        lastName,
        email: raw.email,
        company,
        role,
        seniority,
        location: raw.location,
        fingerprint,
      },
      connectionDate: parseLinkedInDate(raw.connectedOn),
    };
  } catch (error) {
    return { ok: false, row, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface ImportPreviewOptions {
  /** How many rows to include in `contacts` (default 10, cap 50). */
  limit?: number;
  /** Source label the caller wants stamped on the preview (default `linkedin_csv`). */
  source?: string;
  /** Cap on the `issues` array length (default 100, cap 500). */
  maxIssues?: number;
}

/** One previewed row — either a normalized contact or a row that will be skipped. */
export interface ImportPreviewContact {
  row: number;
  fullName: string;
  firstName: string;
  lastName: string;
  email?: string;
  company?: string;
  role?: string;
  seniority?: Seniority;
  location?: string;
  linkedinUrl?: string;
  connectedOn?: string;
  valid: boolean;
  /** Present only when `valid` is false. */
  issue?: string;
}

/** The result of the "Preview / Validate" steps, before anything is imported. */
export interface ImportPreview {
  source: string;
  /** CSV header columns as detected by the parser (empty when the file is empty). */
  columns: string[];
  /** Total data rows (excluding the header). */
  totalRows: number;
  /** Rows that will import or merge cleanly. */
  validRows: number;
  /** Rows that will be skipped. */
  invalidRows: number;
  /** First validation errors, capped at `maxIssues`. */
  issues: ImportError[];
  /** True when `issues` was truncated to `maxIssues`. */
  issuesTruncated: boolean;
  /** First rows for the preview table, capped at `limit`. */
  contacts: ImportPreviewContact[];
  /** True when `contacts` was truncated to `limit`. */
  truncated: boolean;
}

const DEFAULT_COLUMNS = [
  'First Name',
  'Last Name',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
  'URL',
];

/**
 * Read the column names straight off the header line. Used only when the CSV
 * has a header but no data rows (Papa drops the header in that case), so an
 * empty-but-valid upload still previews its real columns.
 */
function detectHeaderColumns(csv: string): string[] {
  const lines = csv.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => /first name/i.test(line) && /last name/i.test(line),
  );
  const headerLine = headerIndex >= 0 ? lines[headerIndex] : lines[0];
  if (!headerLine) return [...DEFAULT_COLUMNS];
  const parsed = headerLine
    .split(',')
    .map((c) => c.replace(/^"|"$/g, '').trim())
    .filter((c) => c.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_COLUMNS];
}

/**
 * Parse and validate a LinkedIn connections CSV without writing to the
 * database. Shared by `netpro import --preview` (CLI) and the server's
 * `POST /api/import/preview` (Web UI).
 */
export function previewImport(csv: string, options: ImportPreviewOptions = {}): ImportPreview {
  const rawContacts = parseLinkedInCSV(csv);
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 10), 50));
  const maxIssues = Math.max(1, Math.min(Math.floor(options.maxIssues ?? 100), 500));

  const issues: ImportError[] = [];
  const contacts: ImportPreviewContact[] = [];
  let validRows = 0;
  let invalidRows = 0;

  for (const [index, raw] of rawContacts.entries()) {
    const row = index + 2; // +1 for 0-index, +1 for the header row
    const analyzed = analyzeImportRow(raw, row);

    if (!analyzed.ok) {
      invalidRows += 1;
      if (issues.length < maxIssues) issues.push({ row, reason: analyzed.reason });
      if (contacts.length < limit) {
        contacts.push({
          row,
          fullName: raw.fullName ?? '',
          firstName: raw.firstName ?? '',
          lastName: raw.lastName ?? '',
          email: raw.email,
          company: raw.company,
          role: raw.position,
          linkedinUrl: raw.linkedinUrl,
          connectedOn: raw.connectedOn,
          valid: false,
          issue: analyzed.reason,
        });
      }
      continue;
    }

    validRows += 1;
    if (contacts.length < limit) {
      contacts.push({
        row,
        fullName: analyzed.contact.fullName,
        firstName: analyzed.contact.firstName,
        lastName: analyzed.contact.lastName,
        email: analyzed.contact.email,
        company: analyzed.contact.company,
        role: analyzed.contact.role,
        seniority: analyzed.contact.seniority,
        location: analyzed.contact.location,
        linkedinUrl: raw.linkedinUrl,
        connectedOn: raw.connectedOn,
        valid: true,
      });
    }
  }

  const columns =
    rawContacts.length > 0
      ? Object.keys(rawContacts[0]?.raw ?? {}).filter((c) => c.trim().length > 0)
      : detectHeaderColumns(csv);

  return {
    source: options.source ?? 'linkedin_csv',
    columns,
    totalRows: rawContacts.length,
    validRows,
    invalidRows,
    issues,
    issuesTruncated: invalidRows > maxIssues,
    contacts,
    truncated: rawContacts.length > limit,
  };
}
