import type { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import { analyzeNetworkGaps, extractSkills, loadSkillContacts, writeExtractedSkills } from '@netpro/core/src/skills';

export interface SkillsCommandOptions { role?: string; description?: string; contact?: string; json?: boolean; persist?: boolean; }

export function renderSkills(value: unknown, json = false): string {
  if (json) return JSON.stringify(value, null, 2);
  if ('skills' in (value as object)) {
    const v = value as ReturnType<typeof extractSkills>;
    return v.skills.length ? v.skills.join(', ') : 'No taxonomy skills found.';
  }
  const v = value as ReturnType<typeof analyzeNetworkGaps>;
  const lines = [`Required: ${v.required.join(', ') || 'none'}`, `Contacts scanned: ${v.contactCount}`];
  for (const gap of v.gaps) lines.push(`${gap.skill}: ${gap.count ? gap.contacts.map((c) => c.fullName).join(', ') : 'no matching contact'}`);
  return lines.join('\n');
}

export async function executeSkills(options: SkillsCommandOptions, conn: SqliteConn | PgConn) {
  const contacts = await loadSkillContacts(conn);
  if (options.contact) {
    const ref = options.contact.toLowerCase();
    const contact = contacts.find((c) => c.id.toLowerCase() === ref || c.fullName.toLowerCase() === ref || c.email?.toLowerCase() === ref);
    if (!contact) throw new Error(`Contact not found: ${options.contact}`);
    const extraction = extractSkills(contact);
    if (options.persist) await writeExtractedSkills(conn, contact.id, extraction);
    return renderSkills(extraction, options.json);
  }
  if (!options.role && !options.description) throw new Error('Provide --role or --description (or --contact).');
  return renderSkills(analyzeNetworkGaps({ role: options.role, description: options.description }, contacts), options.json);
}

export function registerSkillsCommand(program: Command): void {
  const command = program.command('skills').description('Extract skills or find network coverage for a target role');
  command.option('--role <role>', 'Target role, for example "Staff Engineer"');
  command.option('--description <text>', 'Target job description or required skills');
  command.option('--contact <selector>', 'Extract skills for one contact');
  command.option('--json', 'Print machine-readable JSON');
  command.option('--persist', 'Store extracted skills on --contact (source fields remain unchanged)');
  command.action(async (options: SkillsCommandOptions) => {
    const { openDb } = await import('../db');
    console.log(await executeSkills(options, await openDb()));
  });
}
