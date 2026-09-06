import type { Command } from "commander";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_PROFILE_BYTES } from "@netpro/core/src/card/types";
import { parseProfileCardJson } from "@netpro/core/src/card/validation";
import { renderProfileCardHtml } from "@netpro/core/src/card/html";
import { renderProfileVCard } from "@netpro/core/src/card/vcard";

export interface CardCommandOptions {
  generate?: boolean;
  input?: string;
  output?: string;
  format?: string;
}

export function executeCard(options: CardCommandOptions): {
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
  const content =
    format === "html"
      ? renderProfileCardHtml(profile)
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

export function registerCardCommand(program: Command): void {
  program
    .command("card")
    .description(
      "Generate a portable networking card from public-profile JSON (offline)",
    )
    .option(
      "--generate",
      "Generate a card (the default action; does not publish)",
    )
    .requiredOption(
      "--input <path>",
      "Profile JSON from /settings/card or your own file",
    )
    .option("--format <format>", "html or vcard", "html")
    .option("--output <path>", "Write to a file instead of stdout")
    .action((options: CardCommandOptions) => {
      try {
        console.log(executeCard(options).output);
      } catch (error) {
        console.error(`netpro card: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });
}
