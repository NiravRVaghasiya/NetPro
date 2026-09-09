// apps/cli/src/commands/skills.ts
//
// `netpro skills` — the skills gap analyzer from the terminal (v2.0 Phase 5).
//   netpro skills <contact>                  stored + current skills, with evidence
//   netpro skills gap --role/--description/--skills [--contact] [--json]
//                                            who in the network covers a target
//   netpro skills extract [--mode heuristic|ai] [--dry-run] [--contact] [--limit]
//                                            (re)derive and store skills
//   netpro skills status                     coverage counts
//
// Everything here is rendering + flag validation; the extraction, taxonomy,
// gap maths and persistence live in @netpro/core/src/skills so the web
// surface shows exactly the same answers. Offline by default: the AI pass is
// opt-in per run (`--mode ai`) and needs a BYO key from the keychain/env.
import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import { resolveAiProvider, resolveContactRef } from "@netpro/core/src/ai";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import {
  analyzeNetworkGaps,
  extractSkillsBatch,
  gapAnalysis,
  getSkillsProfile,
  loadSkillContacts,
  parseTarget,
  skillCategory,
  skillsStatus,
  type ExtractBatchSummary,
  type GapResult,
  type NetworkGapAnalysis,
  type SkillsProfile,
  type SkillTarget,
} from "@netpro/core/src/skills";
import { readCredentials } from "./outreach";

export interface SkillsGapOptions {
  role?: string;
  description?: string;
  skills?: string;
  contact?: string;
  limit?: string;
  json?: boolean;
}

export interface SkillsExtractOptions {
  mode?: string;
  dryRun?: boolean;
  contact?: string;
  limit?: string;
  provider?: string;
  json?: boolean;
}

const EXTRACT_MODES = ["heuristic", "ai"] as const;
type ExtractMode = (typeof EXTRACT_MODES)[number];

function trim(value: string | undefined): string | undefined {
  const s = value?.trim();
  return s ? s : undefined;
}

function parseLimit(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--limit must be a positive number, got "${value}"`);
  }
  return Math.min(Math.floor(n), max);
}

/** Flags → core target; throws when there is nothing to analyse. */
export function toSkillTarget(opts: SkillsGapOptions): SkillTarget {
  const target: SkillTarget = {
    role: trim(opts.role) ?? null,
    description: trim(opts.description) ?? null,
    skills: trim(opts.skills) ?? null,
  };
  if (!target.role && !target.description && !target.skills) {
    throw new Error(
      'Provide a target: --role "Staff Engineer", --description "<job text>" and/or --skills "python,k8s".',
    );
  }
  return target;
}

export function parseExtractMode(value: string | undefined): ExtractMode {
  const mode = trim(value) ?? "heuristic";
  if (!(EXTRACT_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unknown --mode "${value}". Expected one of: ${EXTRACT_MODES.join(", ")}.`,
    );
  }
  return mode as ExtractMode;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function scoreTag(ref: { relationshipScore?: number | null }): string {
  return typeof ref.relationshipScore === "number"
    ? ` · score ${ref.relationshipScore.toFixed(2)}`
    : "";
}

// ── skills <contact> ─────────────────────────────────────────────────────

export function renderProfile(profile: SkillsProfile): string {
  const { contact, stored, current, unsupported } = profile;
  const who = contact.email
    ? `${contact.fullName} <${contact.email}>`
    : contact.fullName;
  const lines = [`Skills for ${who}`];
  if (stored.length === 0) {
    lines.push(
      "  Stored: none yet — run `netpro skills extract` to derive and store skills.",
    );
  } else {
    lines.push(`  Stored (${stored.length}): ${stored.join(", ")}`);
  }
  if (current.details.length === 0) {
    lines.push(
      "  Current text yields no taxonomy skills (headline, role, notes, tags and custom fields were scanned).",
    );
  } else {
    lines.push(`  From current fields (${current.details.length}):`);
    for (const d of current.details) {
      const ev = d.evidence[0];
      const where = ev ? ` — ${ev.field}: “${ev.snippet}”` : "";
      lines.push(
        `    ${d.skill} [${d.category}] ${d.confidence.toFixed(2)}${where}`,
      );
    }
  }
  if (unsupported.length > 0) {
    lines.push(
      `  Stored but not supported by the current text: ${unsupported.join(", ")}`,
    );
  }
  const latest = profile.evidence[0];
  if (latest) {
    lines.push(
      `  Last extraction: ${latest.provider.replace("skills_", "")} at ${latest.fetchedAt.slice(0, 19).replace("T", " ")}`,
    );
  }
  return lines.join("\n");
}

export async function executeSkillsProfile(
  selector: string,
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const ref = await resolveContactRef(conn, selector, scope);
  const profile = await getSkillsProfile(conn, ref.id, scope);
  if (!profile) throw new Error(`Contact not found: ${selector}`);
  if (opts.json) return JSON.stringify(profile, null, 2);
  return renderProfile(profile);
}

// ── skills gap ───────────────────────────────────────────────────────────

export function renderGap(result: GapResult, name: string): string {
  const lines = [
    `${name}: ${pct(result.matchScore)} match (${result.present.length}/${result.required.length} required)`,
  ];
  if (result.present.length)
    lines.push(`  Present: ${result.present.join(", ")}`);
  if (result.partial.length) {
    lines.push(
      `  Partial: ${result.partial.map((s) => `${s} (via ${result.partialVia[s]?.join(", ") ?? "?"})`).join("; ")}`,
    );
  }
  if (result.missing.length)
    lines.push(`  Missing: ${result.missing.join(", ")}`);
  return lines.join("\n");
}

export function renderNetworkGaps(analysis: NetworkGapAnalysis): string {
  const lines: string[] = [];
  if (analysis.required.length === 0) {
    lines.push(
      "No taxonomy skills recognised in the target — try --skills with explicit names (see `netpro skills gap --help`).",
    );
    if (analysis.target.unrecognized.length) {
      lines.push(
        `  Not in the taxonomy: ${analysis.target.unrecognized.join(", ")}`,
      );
    }
    return lines.join("\n");
  }
  lines.push(
    `Target needs ${analysis.required.length} skill${analysis.required.length === 1 ? "" : "s"}: ${analysis.required.join(", ")}`,
  );
  if (analysis.target.unrecognized.length) {
    lines.push(
      `  (not in the taxonomy, ignored: ${analysis.target.unrecognized.join(", ")})`,
    );
  }
  lines.push(
    `Network: ${analysis.contactCount} contact${analysis.contactCount === 1 ? "" : "s"} scanned · ${analysis.coveredCount}/${analysis.required.length} skills covered`,
  );
  lines.push("");
  lines.push("Coverage:");
  for (const c of analysis.coverage) {
    const who = c.contacts.map((p) => `${p.fullName}${scoreTag(p)}`).join(", ");
    const more =
      c.count > c.contacts.length
        ? ` (+${c.count - c.contacts.length} more)`
        : "";
    const partial = c.partialCount ? ` · ${c.partialCount} partial` : "";
    lines.push(
      `  ${c.skill} [${skillCategory(c.skill)}] — ${c.count}${partial}${who ? `: ${who}${more}` : ""}`,
    );
  }
  if (analysis.gaps.length) {
    lines.push("");
    lines.push(`Gaps — nobody covers: ${analysis.gaps.join(", ")}`);
  }
  if (analysis.candidates.length) {
    lines.push("");
    lines.push("Best matches:");
    for (const [i, c] of analysis.candidates.entries()) {
      const company = c.company ? ` (${c.company})` : "";
      const missing = c.gap.missing.length
        ? ` · missing ${c.gap.missing.join(", ")}`
        : "";
      lines.push(
        `  #${i + 1} ${c.fullName}${company} — ${pct(c.gap.matchScore)}${scoreTag(c)}${missing}`,
      );
    }
  } else {
    lines.push("");
    lines.push(
      "No contact matches any of the required skills yet — `netpro skills extract` derives skills from headlines, notes and tags.",
    );
  }
  return lines.join("\n");
}

export async function executeSkillsGap(
  opts: SkillsGapOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const target = toSkillTarget(opts);
  const selector = trim(opts.contact);
  if (selector) {
    const ref = await resolveContactRef(conn, selector, scope);
    const profile = await getSkillsProfile(conn, ref.id, scope);
    if (!profile) throw new Error(`Contact not found: ${selector}`);
    // Evidence beats a stale stored verdict, but an owner/AI claim the text no
    // longer supports still counts — the stored verdict is the union.
    const have = new Set<string>([
      ...profile.current.skills,
      ...profile.stored,
    ]);
    const parsed = parseTarget(target);
    const gap = gapAnalysis(parsed, have);
    if (opts.json)
      return JSON.stringify({ contact: ref, target: parsed, gap }, null, 2);
    if (parsed.required.length === 0) {
      return "No taxonomy skills recognised in the target — try --skills with explicit names.";
    }
    return renderGap(gap, profile.contact.fullName);
  }

  const limit = parseLimit(opts.limit, 10, 100);
  const contacts = await loadSkillContacts(conn, { scope });
  const analysis = analyzeNetworkGaps(target, contacts, { candidates: limit });
  return opts.json
    ? JSON.stringify(analysis, null, 2)
    : renderNetworkGaps(analysis);
}

// ── skills extract ───────────────────────────────────────────────────────

export function renderExtractSummary(summary: ExtractBatchSummary): string {
  const verb = summary.dryRun ? "would update" : "updated";
  const lines = [
    `${summary.dryRun ? "Dry run — " : ""}scanned ${summary.scanned} contact${summary.scanned === 1 ? "" : "s"} (${summary.mode}): ` +
      `${verb} ${summary.updated}, unchanged ${summary.unchanged}, with skills ${summary.withSkills}`,
  ];
  for (const c of summary.changes.slice(0, 20)) {
    lines.push(
      `  ${c.fullName}: ${c.before.length ? c.before.join(", ") : "∅"} → ${c.after.length ? c.after.join(", ") : "∅"}`,
    );
  }
  if (summary.changes.length > 20)
    lines.push(
      `  … ${summary.changes.length - 20} more (use --json for the full list)`,
    );
  if (summary.aiErrors.length) {
    lines.push(
      `  AI pass failed for ${summary.aiErrors.length} contact${summary.aiErrors.length === 1 ? "" : "s"} (heuristics still applied): ${summary.aiErrors[0]!.error}`,
    );
  }
  if (summary.indexed)
    lines.push(
      `  Search index refreshed for ${summary.indexed.indexed} contact${summary.indexed.indexed === 1 ? "" : "s"}.`,
    );
  return lines.join("\n");
}

export async function executeSkillsExtract(
  opts: SkillsExtractOptions,
  conn: SqliteConn | PgConn,
  now: Date = new Date(),
  scope?: WorkspaceScope,
): Promise<string> {
  const mode = parseExtractMode(opts.mode);
  const limit =
    opts.limit === undefined
      ? undefined
      : parseLimit(opts.limit, 10_000, 10_000);
  let contactIds: string[] | undefined;
  const selector = trim(opts.contact);
  if (selector)
    contactIds = [(await resolveContactRef(conn, selector, scope)).id];

  let provider = null;
  let model: string | undefined;
  if (mode === "ai") {
    // Keys come from the keychain/env only — never from flags or the database.
    const { credentials } = await readCredentials(opts.provider);
    provider = resolveAiProvider(credentials);
    model = credentials.model ?? undefined;
  }

  const summary = await extractSkillsBatch(conn, {
    mode,
    provider,
    model,
    dryRun: opts.dryRun,
    contactIds,
    limit,
    now,
    scope,
  });
  return opts.json
    ? JSON.stringify(summary, null, 2)
    : renderExtractSummary(summary);
}

// ── skills status ────────────────────────────────────────────────────────

export async function executeSkillsStatus(
  opts: { json?: boolean },
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const status = await skillsStatus(conn, scope);
  if (opts.json) return JSON.stringify(status, null, 2);
  const lines = [
    `Contacts: ${status.contacts} · with skills: ${status.withSkills} · never extracted: ${status.neverExtracted}`,
  ];
  if (status.neverExtracted > 0)
    lines.push(
      "Run `netpro skills extract` to derive skills for every contact (offline, no key needed).",
    );
  return lines.join("\n");
}

async function run(
  cmd: Command,
  fn: (conn: SqliteConn | PgConn, scope?: WorkspaceScope) => Promise<string>,
): Promise<void> {
  const { openDb, resolveCliScope } = await import("../db");
  try {
    const conn = await openDb();
    const scope = await resolveCliScope(cmd, conn);
    console.log(await fn(conn, scope));
  } catch (e) {
    console.error(`netpro skills: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "Skills gap analyzer — derive skills, compare a target role against your network (v2.0)",
    )
    .argument(
      "[contact]",
      "Show stored + derived skills for one contact (name, email or id)",
    )
    .option("--json", "Print the result as JSON")
    .action(
      (contact: string | undefined, opts: { json?: boolean }, cmd: Command) => {
        if (!contact) {
          cmd.help();
          return;
        }
        return run(skills, (conn, scope) =>
          executeSkillsProfile(contact, opts, conn, scope),
        );
      },
    );

  skills
    .command("gap")
    .description(
      "Who in your network covers a target role / description / skill list",
    )
    .option("--role <role>", 'Target role, e.g. "Staff Data Engineer"')
    .option("--description <text>", "Job description or requirement list")
    .option(
      "--skills <list>",
      'Explicit skills, comma-separated (e.g. "python,k8s,aws")',
    )
    .option(
      "--contact <selector>",
      "Compare one contact against the target instead of the whole network",
    )
    .option("--limit <n>", "Ranked candidates to show (default 10, max 100)")
    .option("--json", "Print the analysis as JSON")
    .action((opts: SkillsGapOptions) =>
      run(skills, (conn, scope) => executeSkillsGap(opts, conn, scope)),
    );

  skills
    .command("extract")
    .description(
      "Derive skills from headline, role, notes, tags and custom fields, and store them",
    )
    .option(
      "--mode <mode>",
      "heuristic (default, offline) | ai (adds a BYO-key model pass)",
    )
    .option("--contact <selector>", "Only this contact")
    .option("--limit <n>", "Stop after N contacts")
    .option(
      "--provider <provider>",
      "openai | anthropic override for --mode ai",
    )
    .option("--dry-run", "Show what would change without writing anything")
    .option("--json", "Print the summary as JSON")
    .action((opts: SkillsExtractOptions) =>
      run(skills, (conn, scope) =>
        executeSkillsExtract(opts, conn, new Date(), scope),
      ),
    );

  skills
    .command("status")
    .description("How many contacts have derived skills")
    .option("--json", "Print the counts as JSON")
    .action((opts: { json?: boolean }) =>
      run(skills, (conn, scope) => executeSkillsStatus(opts, conn, scope)),
    );
}
