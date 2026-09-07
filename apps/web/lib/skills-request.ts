// apps/web/lib/skills-request.ts
//
// Shared parsing for the v2.0 Phase 5 skills routes. The proxy is the
// ownership boundary (all /api/* require the owner session); these helpers
// cover what the boundary does not: bounded target text, a validated
// extraction mode, and contact selectors that answer the way the graph routes
// do — unknown → 404, ambiguous → 400 — via the one shared resolver.
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveContactRef, type ContactRef } from '@netpro/core/src/ai';
import type { SkillTarget } from '@netpro/core/src/skills';
import { CrmRequestError } from './crm-request';

/** Generous for a pasted job description; the core truncates at 10k anyway. */
export const MAX_TARGET_CHARS = 10_000;

function bounded(raw: string | null | undefined, field: string): string | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  if (value.length > MAX_TARGET_CHARS) {
    throw new CrmRequestError(400, `${field} must be ${MAX_TARGET_CHARS} characters or fewer.`);
  }
  return value;
}

/**
 * `?role=&description=&skills=` → a core target. At least one must be
 * present; otherwise there is nothing to analyse and the caller has a bug.
 */
export function skillTargetParams(sp: URLSearchParams): SkillTarget {
  const target: SkillTarget = {
    role: bounded(sp.get('role'), 'role'),
    description: bounded(sp.get('description'), 'description'),
    skills: bounded(sp.get('skills'), 'skills'),
  };
  if (!target.role && !target.description && !target.skills) {
    throw new CrmRequestError(400, 'Provide at least one of role, description or skills.');
  }
  return target;
}

export function boundedInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Resolve an optional contact selector; errors map to 404 / 400 like the graph routes. */
export async function resolveOptionalContact(
  conn: SqliteConn | PgConn,
  selector: string | null | undefined,
): Promise<ContactRef | null> {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 320) throw new CrmRequestError(400, 'contact selector is too long.');
  try {
    return await resolveContactRef(conn, trimmed);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('Ambiguous')) throw new CrmRequestError(400, msg);
    throw new CrmRequestError(404, msg);
  }
}

export const EXTRACT_MODES = ['heuristic', 'ai'] as const;
export type ExtractMode = (typeof EXTRACT_MODES)[number];

export function extractModeParam(raw: unknown): ExtractMode {
  if (raw === undefined || raw === null || raw === '') return 'heuristic';
  if (typeof raw !== 'string' || !(EXTRACT_MODES as readonly string[]).includes(raw)) {
    throw new CrmRequestError(400, `Unknown mode "${String(raw)}". Expected one of: ${EXTRACT_MODES.join(', ')}.`);
  }
  return raw as ExtractMode;
}
