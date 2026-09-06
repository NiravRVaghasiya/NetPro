import { describe, it, expect } from 'vitest';
import { parseDraftResponse } from './parser';
import { AiProviderError } from './types';

describe('parseDraftResponse', () => {
  it('parses a bare JSON object', () => {
    const draft = parseDraftResponse(
      JSON.stringify({ subject: 'Hello Jane', body: 'Long time no see!' }),
    );
    expect(draft).toEqual({ subject: 'Hello Jane', body: 'Long time no see!' });
  });

  it('parses JSON embedded in surrounding prose', () => {
    const draft = parseDraftResponse(
      'Here you go:\n{"subject":"S","body":"B"}\nHope that helps!',
    );
    expect(draft).toEqual({ subject: 'S', body: 'B' });
  });

  it('parses a fenced ```json block', () => {
    const draft = parseDraftResponse('```json\n{"subject":"S2","body":"B2"}\n```');
    expect(draft).toEqual({ subject: 'S2', body: 'B2' });
  });

  it('parses plain text with a leading Subject: line', () => {
    const draft = parseDraftResponse('Subject: Quick question\n\nHi Jane,\n\nWant to chat?\n\nBest,\nAlex');
    expect(draft.subject).toBe('Quick question');
    expect(draft.body).toContain('Hi Jane');
    expect(draft.body).toContain('Best,\nAlex');
  });

  it('trims whitespace from fields', () => {
    const draft = parseDraftResponse('  {"subject":"  S  ","body":"  B  "}  ');
    expect(draft).toEqual({ subject: 'S', body: 'B' });
  });

  it('throws invalid_response on malformed input', () => {
    for (const bad of ['', 'no structure here', '{"subject":"only subject"}', '{"body":"only body"}']) {
      try {
        parseDraftResponse(bad);
        throw new Error(`expected throw for: ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AiProviderError);
        expect((e as AiProviderError).code).toBe('invalid_response');
      }
    }
  });
});
