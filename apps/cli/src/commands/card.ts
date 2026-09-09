import type { Command } from "commander";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import { MAX_PROFILE_BYTES } from "@netpro/core/src/card/types";
import { parseProfileCardJson } from "@netpro/core/src/card/validation";
import { renderProfileCardHtml } from "@netpro/core/src/card/html";
import { renderProfileVCard } from "@netpro/core/src/card/vcard";
import { getViewsOverview } from "@netpro/core/src/views";
import { renderViewsSection } from "./analyze";

export interface CardCommandOptions {
  generate?: boolean;
  input?: string;
  output?: string;
  format?: string;
  pixelUrl?: string;
  // v2.5 Phase 3 — the viewer-analytics mode. Generation stays offline and
  // file-driven; `--views` is database-driven and shares its renderer with
  // `netpro analyze --views` so the two can never disagree.
  views?: boolean;
  days?: string;
  limit?: string;
  includeBots?: boolean;
  includeOwnerViews?: boolean;
  json?: boolean;
}

function executeCardGenerate(options: CardCommandOptions): {
  output: string;
  content: string;
} {
  if (!options.input)
    throw new Error(
      "--input <profile.json> is required. Only explicitly authored public fields are exported.",
    );
  const format = options.format ?? "html";
  if (format !== "html" && format !== "vcard")
    throw new Error("Card format must be html or vcard.");
  if (options.output && resolve(options.output) === resolve(options.input)) {
    throw new Error("--output must be different from --input.");
  }
  const file = statSync(options.input);
  if (!file.isFile()) throw new Error("--input must be a JSON file.");
  if (file.size > MAX_PROFILE_BYTES)
    throw new Error("Profile JSON must be 32 KiB or smaller.");
  const profile = parseProfileCardJson(readFileSync(options.input, "utf8"));
  if (options.pixelUrl && format !== "html") {
    throw new Error("--pixel-url only applies to HTML cards.");
  }
  const content =
    format === "html"
      ? renderProfileCardHtml(profile, { pixelUrl: options.pixelUrl })
      : renderProfileVCard(profile);
  if (options.output) {
    writeFileSync(options.output, content, "utf8");
    return {
      content,
      output: `Generated ${format} card at ${options.output}. Nothing has been published.`,
    };
  }
  return { content, output: content };
}

function parsePositive(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--${flag} must be a positive integer, got "${value}"`);
  return n;
}

export function executeCard(options: CardCommandOptions): {
  output: string;
  content: string;
} {
  // `--views` is the database mode and runs through `executeCardViews`;
  // reaching here with it (or any of its flags) is a caller bug.
  if (options.views) {
    throw new Error(
      "Use --views without generation flags; run `netpro card --views` on its own.",
    );
  }
  for (const [flag, set] of [
    ["--days", options.days !== undefined],
    ["--limit", options.limit !== undefined],
    ["--include-bots", options.includeBots],
    ["--include-owner-views", options.includeOwnerViews],
    ["--json", options.json],
  ] as const) {
    if (set) throw new Error(`${flag} only applies with --views.`);
  }
  return executeCardGenerate(options);
}

/** `netpro card --views [--days 30] [--limit 10] [--json]` — summary + recent. */
export async function executeCardViews(
  options: CardCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  for (const [flag, set] of [
    ["--input", options.input !== undefined],
    ["--output", options.output !== undefined],
    ["--format", options.format !== undefined],
    ["--pixel-url", options.pixelUrl !== undefined],
  ] as const) {
    if (set)
      throw new Error(`${flag} applies to card generation, not to --views.`);
  }
  // `--generate` is the default-action marker and a no-op elsewhere; in
  // views mode it is simply ignored rather than an error.
  const days = parsePositive(options.days, "days") ?? 30;
  const limit = parsePositive(options.limit, "limit") ?? 10;
  const overview = await getViewsOverview(conn, {
    days,
    limit,
    includeBots: options.includeBots,
    includeOwnerViews: options.includeOwnerViews,
    scope,
  });
  if (options.json) {
    return JSON.stringify(overview, null, 2);
  }
  return renderViewsSection(overview, days).join("\n");
}

export function registerCardCommand(program: Command): void {
  program
    .command("card")
    .description(
      "Generate a portable networking card from public-profile JSON (offline), or show who viewed it (--views)",
    )
    .option(
      "--generate",
      "Generate a card (the default action; does not publish)",
    )
    .option(
      "--input <path>",
      "Profile JSON from /settings/card or your own file (generation only)",
    )
    .option("--format <format>", "html or vcard (default html)")
    .option(
      "--pixel-url <url>",
      "Embed your NetPro view pixel (e.g. https://net.example/api/card/pixel.gif?p=blog) in the HTML card",
    )
    .option("--output <path>", "Write to a file instead of stdout")
    .option(
      "--views",
      "Show profile-view analytics instead of generating a card",
    )
    .option("--days <n>", "Views window in days, 1–90 (default 30)")
    .option("--limit <n>", "Max rows per views list (default 10)")
    .option("--include-bots", "Count bot views too")
    .option("--include-owner-views", "Count your own views too")
    .option("--json", "Print the views overview as JSON (with --views)")
    .action(async (options: CardCommandOptions, cmd: Command) => {
      try {
        if (options.views) {
          const { openDb, resolveCliScope } = await import("../db");
          const conn = await openDb();
          const scope = await resolveCliScope(cmd, conn);
          console.log(await executeCardViews(options, conn, scope));
        } else {
          console.log(executeCard(options).output);
        }
      } catch (error) {
        console.error(`netpro card: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });
}
