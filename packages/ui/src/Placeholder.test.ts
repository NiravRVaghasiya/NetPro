import { describe, it, expect } from 'vitest';
import { Placeholder } from './Placeholder';

describe('@netpro/ui', () => {
  it('exports a Placeholder component function', () => {
    expect(typeof Placeholder).toBe('function');
  });
});
