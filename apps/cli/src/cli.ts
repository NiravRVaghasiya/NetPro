import { Command } from "commander";
import { registerInitCommand } from "./commands/init";
import { registerServeCommand } from "./commands/serve";
import { registerStatusCommand } from "./commands/status";
import { registerTokenCommand } from "./commands/token";
import { registerConfigCommand } from "./commands/config";
import { registerImportCommand } from "./commands/import";
import { registerScanCommand } from "./commands/scan";
import { registerEnrichCommand } from "./commands/enrich";
import { registerSearchCommand } from "./commands/search";
import { registerReindexCommand } from "./commands/reindex";
import { registerOutreachCommand } from "./commands/outreach";
import { registerAnalyzeCommand } from "./commands/analyze";
import { registerPathCommand } from "./commands/path";
import { registerTrackCommand } from "./commands/track";
import { registerEdgeCommand } from "./commands/edge";
import { registerCampaignCommand } from "./commands/campaign";
import { registerCardCommand } from "./commands/card";
import { registerExportCommand } from "./commands/export";
import { registerMigrateCommand } from "./commands/migrate";
import { registerBackupCommand, registerRestoreCommand } from "./commands/backup";
import { registerSkillsCommand } from "./commands/skills";
import { registerEventsCommand } from "./commands/events";
import { registerContentCommand } from "./commands/content";
import { registerTeamCommand } from "./commands/team";
import { registerPluginCommand } from "./commands/plugin";
import { registerWebhookCommand } from "./commands/webhook";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("netpro")
    .description("NetPro — your professional network, owned by you")
    .version("3.0.2")
    // v3.0 Phase 2 — one workspace scope per invocation. Precedence:
    // flag → NETPRO_WORKSPACE → config → bootstrap workspace.
    .option(
      "--workspace <id>",
      "Operate in workspace <id> (default: bootstrap workspace)",
    );

  registerInitCommand(program);
  registerServeCommand(program);
  registerStatusCommand(program);
  registerTokenCommand(program);
  registerConfigCommand(program);
  registerImportCommand(program);
  registerScanCommand(program);
  registerEnrichCommand(program);
  registerSearchCommand(program);
  registerReindexCommand(program);
  registerOutreachCommand(program);
  registerAnalyzeCommand(program);
  registerPathCommand(program);
  registerTrackCommand(program);
  registerEdgeCommand(program);
  registerCampaignCommand(program);
  registerExportCommand(program);
  registerCardCommand(program);
  registerMigrateCommand(program);
  registerBackupCommand(program);
  registerRestoreCommand(program);
  registerSkillsCommand(program);
  registerEventsCommand(program);
  registerContentCommand(program);
  registerTeamCommand(program);
  registerPluginCommand(program);
  registerWebhookCommand(program);

  return program;
}
