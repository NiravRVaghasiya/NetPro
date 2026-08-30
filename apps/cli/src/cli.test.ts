import { describe, it, expect } from 'vitest';
import { createProgram } from './cli';

describe('CLI root program', () => {
  it('is named netpro with a version', () => {
    const program = createProgram();
    expect(program.name()).toBe('netpro');
    expect(program.version()).toBe('0.1.0-alpha.0');
  });
});
