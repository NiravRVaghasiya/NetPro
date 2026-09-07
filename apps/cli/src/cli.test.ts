import { describe, it, expect } from 'vitest';
import { createProgram } from './cli';

describe('CLI root program', () => {
  it('is named netpro with a version', () => {
    const program = createProgram();
    expect(program.name()).toBe('netpro');
    expect(program.version()).toBe('1.5.0');
  });

  it('registers all fourteen top-level commands', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(['init', 'config', 'import', 'enrich', 'search', 'outreach', 'analyze', 'path', 'track', 'edge', 'campaign', 'export', 'card', 'migrate']);
  });

  it('registers the campaign subcommands', () => {
    const program = createProgram();
    const campaign = program.commands.find((c) => c.name() === 'campaign');
    expect(campaign).toBeDefined();
    const subNames = (campaign as import('commander').Command).commands.map((c) => c.name());
    expect(subNames).toEqual([
      'list',
      'create',
      'add-recipients',
      'show',
      'activate',
      'pause',
      'complete',
      'archive',
      'mark-sent',
      'mark-replied',
      'mark-skipped',
    ]);
  });

  it('registers config subcommands set/get/delete/list', () => {
    const program = createProgram();
    const config = program.commands.find((c) => c.name() === 'config');
    expect(config).toBeDefined();
    const subNames = (config as import('commander').Command).commands.map((c) => c.name());
    expect(subNames).toEqual(['set', 'get', 'delete', 'list']);
  });
});
