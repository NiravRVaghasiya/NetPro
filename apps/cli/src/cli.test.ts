import { describe, it, expect } from 'vitest';
import { createProgram } from './cli';

describe('CLI root program', () => {
  it('is named netpro with a version', () => {
    const program = createProgram();
    expect(program.name()).toBe('netpro');
    expect(program.version()).toBe('3.0.0');
  });

  it('registers all twenty-four top-level commands (v3.0 Phase 1 adds team, Phase 5 adds plugin, Phase 7 adds webhook; local-first adds serve + status + token)', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(['init', 'serve', 'status', 'token', 'config', 'import', 'enrich', 'search', 'reindex', 'outreach', 'analyze', 'path', 'track', 'edge', 'campaign', 'export', 'card', 'migrate', 'skills', 'events', 'content', 'team', 'plugin', 'webhook']);
  });

  it('wires netpro token with rotate/path/json flags (local-first Phase 5)', () => {
    const program = createProgram();
    const token = program.commands.find((c) => c.name() === 'token');
    expect(token).toBeDefined();
    expect((token as import('commander').Command).options.map((o) => o.long)).toEqual([
      '--rotate',
      '--path',
      '--json',
    ]);
  });

  it('wires netpro serve with host/port options (local-first Phase 2)', () => {
    const program = createProgram();
    const serve = program.commands.find((c) => c.name() === 'serve');
    expect(serve).toBeDefined();
    const names = (serve as import('commander').Command).options.map((o) => o.long);
    expect(names).toEqual(['--host', '--port']);
  });

  it('wires netpro status with a --json flag (local-first Phase 2)', () => {
    const program = createProgram();
    const status = program.commands.find((c) => c.name() === 'status');
    expect(status).toBeDefined();
    expect((status as import('commander').Command).options.map((o) => o.long)).toEqual(['--json']);
  });

  it('registers the content subcommands (v2.5 Phase 5)', () => {
    const program = createProgram();
    const content = program.commands.find((c) => c.name() === 'content');
    expect(content).toBeDefined();
    const subNames = (content as import('commander').Command).commands.map((c) => c.name());
    expect(subNames).toEqual(['list', 'add', 'show', 'import', 'fetch', 'rm', 'analyze']);
  });

  it('registers the events subcommands (v2.0 Phase 6)', () => {
    const program = createProgram();
    const events = program.commands.find((c) => c.name() === 'events');
    expect(events).toBeDefined();
    const subNames = (events as import('commander').Command).commands.map((c) => c.name());
    expect(subNames).toEqual(['list', 'show', 'add', 'import', 'match', 'link', 'unlink', 'recommend', 'rm']);
  });

  it('registers the skills subcommands (v2.0 Phase 5)', () => {
    const program = createProgram();
    const skills = program.commands.find((c) => c.name() === 'skills');
    expect(skills).toBeDefined();
    const subNames = (skills as import('commander').Command).commands.map((c) => c.name());
    expect(subNames).toEqual(['gap', 'extract', 'status']);
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
