// apps/cli/src/commands/path.ts
//
// `netpro path <target>` — the warm-intro pathfinder surface (v2.0 Phase 3).
//   --from <selector>     start from a specific contact (default: your
//                         strongest tie, reported as such so the default is
//                         never silent)
//   --max-depth n         BFS hop budget (default 4, hard cap 8)
//   --relation r          restrict to one provenance relation
//   --status s            confirmed | all | pending (rejected is never used)
//   --alt n               ranked k-shortest alternatives to show (1–5)
//   --draft               compose the first-ask email via BYO-key AI (draft
//                         only — NetPro never sends anything)
//   --json                machine-readable plan payload
import type { Command } from "commander";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  planIntroPaths,
  buildIntroAskInput,
  EDGE_RELATIONS,
  type IntroPathPlan,
  type GraphAnalysisOptions,
  type RankedIntroPath,
} from "@netpro/core/src/graph";
import {
  composeOutreachMessage,
  resolveAiProvider,
  TONE_VALUES,
  validateComposeInput,
  type OutreachTone,
} from "@netpro/core/src/ai";
import { readCredentials } from "./outreach";
import { Keychain } from "../config/keychain";

export interface PathCommandOptions {
  from?: string;
  maxDepth?: string;
  relation?: string;
  status?: string;
  alt?: string;
  draft?: boolean;
  tone?: string;
  sender?: string;
  provider?: string;
  json?: boolean;
}

/** Parse + validate the plan flags into core options (throws actionable errors). */
export function toPlanInput(
  opts: PathCommandOptions,
  target: string,
): {
  input: { target: string; from?: string; k?: number };
  graphOpts: GraphAnalysisOptions;
} {
  const trim = (v: string | undefined): string | undefined => {
    const s = v?.trim();
    return s ? s : undefined;
  };

  let maxDepth: number | undefined;
  if (opts.maxDepth !== undefined) {
    maxDepth = Number(opts.maxDepth);
    if (!Number.isFinite(maxDepth) || maxDepth < 1) {
      throw new Error(
        `--max-depth must be a positive number, got "${opts.maxDepth}"`,
      );
    }
  }

  let k: number | undefined;
  if (opts.alt !== undefined) {
    k = Number(opts.alt);
    if (!Number.isFinite(k) || k < 1) {
      throw new Error(`--alt must be a positive number, got "${opts.alt}"`);
    }
  }

  const relation: string | undefined = trim(opts.relation);
  if (relation && !(EDGE_RELATIONS as readonly string[]).includes(relation)) {
    throw new Error(
      `Unknown --relation "${relation}". Expected one of: ${EDGE_RELATIONS.join(", ")}.`,
    );
  }

  let status: GraphAnalysisOptions["status"];
  const statusRaw = trim(opts.status);
  if (statusRaw === undefined || statusRaw === "confirmed") {
    status = "confirmed";
  } else if (statusRaw === "all" || statusRaw === "pending") {
    status = statusRaw;
  } else {
    throw new Error(
      `Unknown --status "${statusRaw}". Expected confirmed, all, or pending.`,
    );
  }

  return {
    input: { target, from: trim(opts.from), k },
    graphOpts: { maxDepth, relation, status },
  };
}

function hopLabel(p: RankedIntroPath): string {
  return `${p.hops} hop${p.hops === 1 ? "" : "s"}`;
}

function nodeMeta(n: RankedIntroPath["path"][number]): string {
  const bits: string[] = [];
  if (n.relationshipScore !== null)
    bits.push(`score ${n.relationshipScore.toFixed(2)}`);
  if (n.lastInteraction) bits.push(`last ${n.lastInteraction.slice(0, 10)}`);
  if (n.via?.oneWay) bits.push("one-way");
  return bits.length ? ` (${bits.join(" · ")})` : "";
}

/** Text rendering of the ranked plan (one line per path + its ask). */
export function renderPathPlan(plan: IntroPathPlan): string[] {
  const originTag =
    plan.origin.selectedBy === "strongest-tie"
      ? `${plan.origin.fullName} (your strongest tie)`
      : plan.origin.fullName;
  const header = `Warm-intro to ${plan.target.fullName} from ${originTag} — max ${plan.maxDepth} hop${plan.maxDepth === 1 ? "" : "s"}`;
  if (!plan.found) {
    return [
      header,
      `  No path within ${plan.maxDepth} hop${plan.maxDepth === 1 ? "" : "s"} over the analyzed edges — link people with ` +
        "'netpro edge add' or widen the search (--max-depth, --status all).",
    ];
  }
  const lines = [header];
  for (const p of plan.paths) {
    const chain = p.path.map((n) => `${n.fullName}${nodeMeta(n)}`).join(" → ");
    // Phase 13 — the first-class path summary: strength, weakest tie, and
    // average hop strength beside the hop count, matching the Web UI cards.
    const weakest =
      p.score.weakestTie === null ? "direct" : p.score.weakestTie.toFixed(2);
    lines.push(
      `  #${p.rank} (${hopLabel(p)}) · score ${p.score.score.toFixed(2)} · weakest ${weakest} · avg ${p.score.avgHopStrength.toFixed(2)}`,
    );
    lines.push(`    ${chain}`);
    lines.push(`    → ${p.ask.suggestion}`);
  }
  if (plan.origin.selectedBy === "strongest-tie") {
    lines.push(
      "  (origin defaults to your strongest tie — pass --from to override)",
    );
  }
  return lines;
}

export interface PathJsonPayload {
  plan: IntroPathPlan;
  draft?: Awaited<ReturnType<typeof composeDraftFor>>;
  draftError?: string;
}

/** Plan text plus the outcome of an explicit --draft step, for scripts/exit codes. */
export interface PathResult {
  output: string;
  json: string;
  draftError?: string;
}

async function composeDraftFor(
  plan: IntroPathPlan,
  conn: SqliteConn | PgConn,
  opts: PathCommandOptions,
  scope?: WorkspaceScope,
) {
  const top = plan.paths[0]!;
  const senderKeychain = await Keychain.get("user.name");
  const { credentials } = await readCredentials(opts.provider);
  const provider = resolveAiProvider(credentials);
  const input = await buildIntroAskInput(conn, plan, top, {
    senderName: opts.sender?.trim() || senderKeychain?.trim() || undefined,
    tone: (opts.tone as OutreachTone) ?? "warm",
    scope,
  });
  const draft = await composeOutreachMessage(validateComposeInput(input), {
    provider,
  });
  return draft;
}

export async function executePathDetailed(
  opts: PathCommandOptions,
  target: string,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<PathResult> {
  const { input, graphOpts } = toPlanInput(opts, target);
  const plan = await planIntroPaths(conn, input, { ...graphOpts, scope });

  let draft: PathJsonPayload["draft"];
  let draftError: string | undefined;
  if (opts.draft) {
    if (!plan.found) {
      draftError = "nothing to draft — no path was found.";
    } else {
      try {
        draft = await composeDraftFor(plan, conn, opts, scope);
      } catch (e) {
        // The plan itself is still useful; surface the AI failure honestly.
        draftError = (e as Error).message;
      }
    }
  }

  const payload: PathJsonPayload = {
    plan,
    ...(draft ? { draft } : {}),
    ...(draftError ? { draftError } : {}),
  };

  const lines = renderPathPlan(plan);
  if (draft) {
    lines.push(
      "",
      `Draft ask for ${plan.paths[0]!.ask.fullName} (review + send yourself — NetPro never sends):`,
      `Subject: ${draft.subject}`,
      "",
      draft.body,
    );
  } else if (!draftError && plan.found) {
    lines.push(
      "",
      "Tip: --draft composes the ask email (BYO key); the composer prefill text is in the plan JSON.",
    );
  }
  return {
    output: lines.join("\n"),
    json: JSON.stringify(payload, null, 2),
    ...(draftError ? { draftError } : {}),
  };
}

/** Thin wrapper: exactly what the command prints, human or JSON. */
export async function executePath(
  opts: PathCommandOptions,
  target: string,
  conn: SqliteConn | PgConn,
): Promise<string> {
  const result = await executePathDetailed(opts, target, conn);
  return opts.json ? result.json : result.output;
}

export function registerPathCommand(program: Command): void {
  program
    .command("path <target>")
    .description(
      "Find a warm-intro chain to a contact and the first ask to make (v2.0)",
    )
    .option("--from <selector>", "start contact (default: your strongest tie)")
    .option("--max-depth <n>", "hop budget, 1–8 (default 4)", "4")
    .option(
      "--relation <rel>",
      `only walk this relation: ${EDGE_RELATIONS.join(" | ")}`,
    )
    .option("--status <s>", "confirmed | all | pending (default confirmed)")
    .option("--alt <n>", "ranked alternatives to show (1–5, default 1)")
    .option("--draft", "also compose the ask email (AI, draft-only — you send)")
    .option(
      "--tone <tone>",
      `draft tone for --draft: ${TONE_VALUES.join(" | ")}`,
      "warm",
    )
    .option("--sender <name>", "your name for the draft sign-off")
    .option("--provider <provider>", "openai | anthropic override for --draft")
    .option("--json", "print the full plan (and draft, if any) as JSON")
    .action(async (target: string, opts: PathCommandOptions, cmd: Command) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const result = await executePathDetailed(opts, target, conn, scope);
        console.log(opts.json ? result.json : result.output);
        if (result.draftError) {
          // An explicitly requested draft that failed must not look like a
          // full success to scripts — non-zero exit; the plan already printed.
          console.error(
            `netpro path: draft step failed — ${result.draftError}`,
          );
          process.exitCode = 1;
        }
      } catch (e) {
        console.error(`netpro path: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
