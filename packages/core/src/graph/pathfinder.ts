// packages/core/src/graph/pathfinder.ts
//
// v2.0 Phase 3 — the warm-intro pathfinder SURFACE engine. Phase 2 shipped
// `findIntroPaths` (raw BFS chains); this module turns chains into
// decisions the CLI (`netpro path`) and the web app (`/graph`,
// `GET /api/graph/paths`) can present:
//
//   * `rankIntroPaths`     — score every equal-length shortest chain by
//                            relationship strength (plan: "ship the
//                            k-shortest candidate list, rank by score in a
//                            UI, let the human choose" — no auto-pick).
//   * `defaultPathOrigin`  — which contact `netpro path` starts from when
//                            `--from` is omitted: your strongest tie
//                            (highest relationshipScore; ties: most recent
//                            interaction, then lowest id).
//   * `planIntroPaths`     — selectors to plan: resolves `target`/`from`
//                            through the shared `resolveContactRef`, runs
//                            the pathfinder, ranks the chains, annotates
//                            each with the first ask to make.
//   * `buildIntroAskInput` — the ComposeOutreachInput for the "draft the
//                            ask" step. Draft-only by contract (the Phase 4
//                            posture): this module only BUILDS the input;
//                            the surface composes via `packages/core/ai`
//                            with BYO-key credentials and a human sends.
//
// Scoring (documented choice, deliberately hand-computable):
//   score = 0.6 x weakestTie + 0.4 x avgHopStrength
//   - weakestTie     = the LOWEST relationshipScore among the nodes you
//                      must ask (origin + intermediaries; null scores count
//                      as 0 — an unproven tie ranks below a proven one).
//                      A direct connection has no weak link: tie term = 1.
//   - avgHopStrength = mean over hops of (min strength x min confidence).
// Determinism: equal scores order by the lexicographically smallest id
// chain, so reruns are byte-identical.
import { and, isNull, sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  contactToRecipientInput,
  getContactById,
  resolveContactRef,
  type ContactRef,
} from "../ai/resolve-contact";
import type { ComposeOutreachInput, OutreachTone } from "../ai/prompt";
import { LIMITS as COMPOSE_LIMITS } from "../ai/compose";
import type { GraphAnalysisOptions } from "./analysis";
import { findIntroPaths, type IntroPath, type IntroPathNode } from "./paths";
import { GraphError } from "./types";
import { workspacePredicate, type WorkspaceScope } from "../workspaces/scope";

/** Budgets and knobs specific to the Phase 3 surface (not the engine). */
export const PATHFINDER_LIMITS = {
  /** The web API caps `depth` tighter than the engine's hard cap (8). */
  apiMaxDepth: 6,
  /** Ranked alternatives a surface may request (engine cap is also 5). */
  maxAlternatives: 5,
  /** Default alternatives for `GET /api/graph/paths` and the `/graph` page. */
  defaultAlternatives: 3,
} as const;

export const PATH_SCORE_WEIGHTS = {
  weakestTie: 0.6,
  hopStrength: 0.4,
} as const;

export interface IntroPathScore {
  /**
   * Min relationshipScore over the nodes you must ask (origin +
   * intermediaries). Null only for a DIRECT connection (1 hop, nothing to
   * ask through) — that case scores the tie term as 1.
   */
  weakestTie: number | null;
  /** Mean of (minStrength x minConfidence) over the hops. */
  avgHopStrength: number;
  /** 0-1, rounded to 3 decimals. */
  score: number;
}

export interface IntroPathAsk {
  /** Who to write to first: this is someone you know directly. */
  contactId: string;
  fullName: string;
  relationshipScore: number | null;
  lastInteraction: string | null;
  /** Who to ask them for: the target when adjacent, else the next hop. */
  askForId: string;
  askForName: string;
  /** True when the ask person has a direct edge to the target. */
  adjacentToTarget: boolean;
  /** One deterministic human line describing the move. */
  suggestion: string;
}

export interface RankedIntroPath extends IntroPath {
  /** 1-based rank inside this plan (1 = strongest chain). */
  rank: number;
  score: IntroPathScore;
  ask: IntroPathAsk;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Every node you could ask first: origin plus intermediaries (not the target). */
function askableNodes(path: IntroPath): IntroPathNode[] {
  return path.path.slice(0, -1);
}

/** Score of one chain — exported pure for tests (hand-checkable arithmetic). */
export function scoreIntroPath(path: IntroPath): IntroPathScore {
  const direct = path.hops === 1;
  const weakestTie = direct
    ? null
    : Math.min(...askableNodes(path).map((n) => n.relationshipScore ?? 0));
  const hopStrengths = path.path
    .slice(1)
    .map((n) => (n.via ? n.via.minStrength * n.via.minConfidence : 0));
  const avgHopStrength =
    hopStrengths.length > 0
      ? hopStrengths.reduce((a, b) => a + b, 0) / hopStrengths.length
      : 0;
  const score =
    PATH_SCORE_WEIGHTS.weakestTie * (weakestTie ?? 1) +
    PATH_SCORE_WEIGHTS.hopStrength * avgHopStrength;
  return {
    weakestTie,
    avgHopStrength: round3(avgHopStrength),
    score: round3(score),
  };
}

/**
 * The node you ask first: among origin + intermediaries (everyone you
 * know), the strongest tie wins; ties resolve toward the target (shorter
 * remaining chain), matching the rule Phase 2 uses for its `viaId`, so the
 * dashboard and the pathfinder never disagree.
 */
function pickAsk(path: IntroPath): {
  node: IntroPathNode;
  next: IntroPathNode;
} {
  const candidates = askableNodes(path);
  let bestIndex = 0;
  candidates.forEach((n, i) => {
    const s = n.relationshipScore ?? 0;
    const b = candidates[bestIndex]!.relationshipScore ?? 0;
    if (s > b || (s === b && i > bestIndex)) bestIndex = i;
  });
  const node = candidates[bestIndex]!;
  const next = path.path[bestIndex + 1] ?? path.path[path.path.length - 1]!;
  return { node, next };
}

function buildAsk(path: IntroPath): IntroPathAsk {
  const { node, next } = pickAsk(path);
  const target = path.path[path.path.length - 1]!;
  const adjacent = next.contactId === target.contactId;
  // When the ask person is adjacent to the target, the line cites the edge
  // that connects THEM to the target (the target's inbound hop) — not the
  // edge that connects the ask person to this chain.
  const relations = adjacent ? (target.via?.relations.join(", ") ?? "") : "";
  const meta = [
    node.relationshipScore !== null
      ? `score ${node.relationshipScore.toFixed(2)}`
      : "no score yet",
    node.lastInteraction
      ? `last touch ${node.lastInteraction.slice(0, 10)}`
      : "no recorded touch",
  ].join(" · ");
  const remaining = path.hops - (path.path.indexOf(node) + 1);
  const suggestion = adjacent
    ? `Ask ${node.fullName} (${meta}) for an introduction to ${target.fullName}` +
      `${relations ? ` — the ${relations} link goes straight to them` : ""}.`
    : `Ask ${node.fullName} (${meta}) to connect you with ${next.fullName}; ` +
      `from there ${remaining} more hop${remaining === 1 ? "" : "s"} to ${target.fullName}.`;
  return {
    contactId: node.contactId,
    fullName: node.fullName,
    relationshipScore: node.relationshipScore,
    lastInteraction: node.lastInteraction,
    askForId: next.contactId,
    askForName: next.fullName,
    adjacentToTarget: adjacent,
    suggestion,
  };
}

/**
 * Rank up-to-k equal-length shortest chains: score desc, then the
 * lexicographically smallest id chain — deterministic by construction.
 * Exported pure so tests hand-check the ordering.
 */
export function rankIntroPaths(paths: IntroPath[]): RankedIntroPath[] {
  const decorated = paths.map((path) => ({
    path,
    score: scoreIntroPath(path),
  }));
  decorated.sort((a, b) => {
    if (b.score.score !== a.score.score) return b.score.score - a.score.score;
    const ka = a.path.path.map((n) => n.contactId).join(">");
    const kb = b.path.path.map((n) => n.contactId).join(">");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return decorated.map((entry, i) => ({
    ...entry.path,
    rank: i + 1,
    score: entry.score,
    ask: buildAsk(entry.path),
  }));
}

/** One live contact projected for path display. */
export interface PathPlanContact {
  contactId: string;
  fullName: string;
  company: string | null;
  role: string | null;
}

export interface PathPlanOrigin extends PathPlanContact {
  relationshipScore: number | null;
  lastInteraction: string | null;
  /** How the origin was picked — surfaces disclose this so the default is never silent. */
  selectedBy: "explicit" | "strongest-tie";
}

export interface PlanIntroPathsInput {
  /** Contact selector for the person you want to reach (email | id | unique name). */
  target: string;
  /** Contact selector for the chain start; omitted → your strongest tie. */
  from?: string;
  /** Number of equal-length ranked alternatives (1–5; default 1). */
  k?: number;
}

export interface IntroPathPlan {
  target: PathPlanContact;
  origin: PathPlanOrigin;
  maxDepth: number;
  found: boolean;
  /** True when nothing connects origin to target within maxDepth. */
  unreachable: boolean;
  paths: RankedIntroPath[];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function planContact(ref: {
  id: string;
  fullName: string;
  company: string | null;
  role: string | null;
}): PathPlanContact {
  return {
    contactId: ref.id,
    fullName: ref.fullName,
    company: ref.company,
    role: ref.role,
  };
}

/**
 * Resolve a contact selector for a pathfinder field, mapping resolve-contact
 * errors onto GraphError codes so every surface answers the same way:
 * unknown → not_found (404), ambiguous → invalid_input (400).
 */
async function resolveSelector(
  conn: SqliteConn | PgConn,
  selector: string,
  field: string,
  scope?: WorkspaceScope,
): Promise<ContactRef> {
  try {
    return await resolveContactRef(conn, selector, scope);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("Ambiguous"))
      throw new GraphError("invalid_input", `${field}: ${msg}`);
    throw new GraphError("not_found", `${field}: ${msg}`);
  }
}

/**
 * The owner's strongest tie — the default pathfinder origin. Ranked by
 * relationshipScore (null last), then most recent interaction, then id.
 * Null when the database has no live contacts.
 */
export async function defaultPathOrigin(
  conn: SqliteConn | PgConn,
  opts: { exceptContactId?: string; scope?: WorkspaceScope } = {},
): Promise<ContactRef | null> {
  // Drizzle's typed builders need dialect-narrowed tables (same pattern as
  // analysis.ts); the queries themselves are plain ANSI SQL. The exclusion
  // keeps the default origin from being the target itself (a fresh network
  // with uniform scores would otherwise hit that on the first query).
  if (conn.dialect === "sqlite") {
    const t = conn.schema.contacts;
    const rows = await conn.db
      .select({
        id: t.id,
        fullName: t.fullName,
        email: t.email,
        company: t.company,
        role: t.role,
        headline: t.headline,
        location: t.location,
        industry: t.industry,
        linkedinUrl: t.linkedinUrl,
        githubUrl: t.githubUrl,
        notes: t.notes,
      })
      .from(t)
      .where(
        opts.exceptContactId
          ? and(
              isNull(t.deletedAt),
              workspacePredicate(opts.scope, t.workspaceId),
              sql`${t.id} <> ${opts.exceptContactId}`,
            )
          : and(
              isNull(t.deletedAt),
              workspacePredicate(opts.scope, t.workspaceId),
            ),
      )
      .orderBy(
        sql`CASE WHEN ${t.relationshipScore} IS NULL THEN 1 ELSE 0 END`,
        sql`COALESCE(${t.relationshipScore}, -1) DESC`,
        sql`CASE WHEN ${t.lastInteraction} IS NULL THEN 1 ELSE 0 END`,
        sql`${t.lastInteraction} DESC`,
        sql`${t.id} ASC`,
      )
      .limit(1);
    return (rows[0] ?? null) as ContactRef | null;
  }
  const t = conn.schema.contacts;
  const rows = await conn.db
    .select({
      id: t.id,
      fullName: t.fullName,
      email: t.email,
      company: t.company,
      role: t.role,
      headline: t.headline,
      location: t.location,
      industry: t.industry,
      linkedinUrl: t.linkedinUrl,
      githubUrl: t.githubUrl,
      notes: t.notes,
    })
    .from(t)
    .where(
      opts.exceptContactId
        ? and(
            isNull(t.deletedAt),
            workspacePredicate(opts.scope, t.workspaceId),
            sql`${t.id} <> ${opts.exceptContactId}`,
          )
        : and(
            isNull(t.deletedAt),
            workspacePredicate(opts.scope, t.workspaceId),
          ),
    )
    .orderBy(
      sql`CASE WHEN ${t.relationshipScore} IS NULL THEN 1 ELSE 0 END`,
      sql`COALESCE(${t.relationshipScore}, -1) DESC`,
      sql`CASE WHEN ${t.lastInteraction} IS NULL THEN 1 ELSE 0 END`,
      sql`${t.lastInteraction} DESC`,
      sql`${t.id} ASC`,
    )
    .limit(1);
  return (rows[0] ?? null) as ContactRef | null;
}

/**
 * The one call every Phase 3 surface makes: selectors in, ranked plan out.
 * `opts` forwards the graph analysis options (status/relation/minConfidence/
 * maxDepth); `k` bounds the ranked alternatives (1–5).
 */
export async function planIntroPaths(
  conn: SqliteConn | PgConn,
  input: PlanIntroPathsInput,
  opts: GraphAnalysisOptions = {},
): Promise<IntroPathPlan> {
  const targetSel = (input.target ?? "").trim();
  if (!targetSel)
    throw new GraphError(
      "invalid_input",
      "A target contact is required (name, email, or id).",
    );
  const target = await resolveSelector(conn, targetSel, "Target", opts.scope);

  let originRef: ContactRef;
  let selectedBy: PathPlanOrigin["selectedBy"];
  const fromSel = (input.from ?? "").trim();
  if (fromSel) {
    originRef = await resolveSelector(conn, fromSel, "Origin", opts.scope);
    selectedBy = "explicit";
  } else {
    const fallback = await defaultPathOrigin(conn, {
      exceptContactId: target.id,
      scope: opts.scope,
    });
    if (!fallback) {
      throw new GraphError(
        "not_found",
        "No other live contact to start a chain from — the pathfinder needs at least one contact besides the target.",
      );
    }
    originRef = fallback;
    selectedBy = "strongest-tie";
  }
  if (originRef.id === target.id) {
    throw new GraphError(
      "invalid_input",
      "Target and origin are the same contact — pick a different --from.",
    );
  }

  const k = Math.min(
    Math.max(Math.trunc(input.k ?? 1), 1),
    PATHFINDER_LIMITS.maxAlternatives,
  );
  const result = await findIntroPaths(conn, originRef.id, target.id, {
    ...opts,
    k,
  });

  let originScore: number | null = null;
  let originTouch: string | null = null;
  if (result.found && result.paths[0]) {
    const node = result.paths[0].path[0]!;
    originScore = node.relationshipScore;
    originTouch = node.lastInteraction;
  }

  return {
    target: planContact(target),
    origin: {
      ...planContact(originRef),
      relationshipScore: originScore,
      lastInteraction: originTouch,
      selectedBy,
    },
    maxDepth: result.maxDepth,
    found: result.found,
    unreachable: result.unreachable,
    paths: rankIntroPaths(result.paths),
  };
}

export interface IntroAskText {
  context: string;
  purpose: string;
}

/**
 * The human-readable chain facts behind an ask — the same text feeds the
 * CLI hint and the web composer prefill, so both surfaces describe the
 * path identically. Pure; bounded to the compose context cap.
 */
export function introAskText(
  plan: IntroPathPlan,
  path: RankedIntroPath,
): IntroAskText {
  const chain = path.path.map((n) => n.fullName).join(" → ");
  const originLine =
    plan.origin.selectedBy === "strongest-tie"
      ? `(your strongest tie${plan.origin.relationshipScore !== null ? `, score ${plan.origin.relationshipScore.toFixed(2)}` : ""})`
      : "";
  const context = clip(
    [
      `Warm-intro chain in NetPro: ${chain} (${path.hops} hop${path.hops === 1 ? "" : "s"}, within depth ${plan.maxDepth}).`,
      originLine ? `Starting from ${plan.origin.fullName} ${originLine}.` : "",
      `Your relationship with ${path.ask.fullName}: ` +
        `${path.ask.relationshipScore !== null ? `score ${path.ask.relationshipScore.toFixed(2)}` : "no score recorded"}` +
        `${path.ask.lastInteraction ? `, last touch ${path.ask.lastInteraction.slice(0, 10)}` : ", no recorded touch"}.`,
      path.ask.adjacentToTarget
        ? `${path.ask.fullName} is directly connected to ${plan.target.fullName}.`
        : `The chain continues through ${path.ask.askForName} before reaching ${plan.target.fullName}.`,
    ]
      .filter(Boolean)
      .join(" "),
    COMPOSE_LIMITS.context,
  );
  const targetLine = [
    `an introduction to ${plan.target.fullName}`,
    [plan.target.role, plan.target.company].filter(Boolean).length
      ? `(${[plan.target.role, plan.target.company].filter(Boolean).join(" at ")})`
      : "",
    "— happy to send a short blurb you can forward.",
  ]
    .filter(Boolean)
    .join(" ");
  return { context, purpose: clip(targetLine, COMPOSE_LIMITS.purpose) };
}

/**
 * Build the ComposeOutreachInput for drafting the ask (the CLI's `--draft`
 * and the web composer share this). Loads the LIVE profile of the person
 * being asked so the prompt personalizes exactly like `netpro outreach`.
 * Throws not_found if the ask contact disappeared between planning and
 * drafting.
 */
export async function buildIntroAskInput(
  conn: SqliteConn | PgConn,
  plan: IntroPathPlan,
  path: RankedIntroPath,
  opts: {
    senderName?: string;
    tone?: OutreachTone;
    scope?: WorkspaceScope;
  } = {},
): Promise<ComposeOutreachInput> {
  const askRef = await getContactById(conn, path.ask.contactId, opts.scope);
  if (!askRef) {
    throw new GraphError(
      "not_found",
      `Contact "${path.ask.fullName}" is no longer available to draft to.`,
    );
  }
  const text = introAskText(plan, path);
  return {
    recipient: contactToRecipientInput(askRef),
    senderName: opts.senderName,
    tone: opts.tone ?? "warm",
    context: text.context,
    purpose: text.purpose,
  };
}
