// packages/core/src/graph/types.ts
//
// Whitelisted vocabularies for the edges table. Relation is how two of
// *your* contacts know each other; source is how NetPro learned it;
// status is the confirmation gate — inferred rows stay pending until the
// owner confirms. Nothing here is free-text because analytics (Phase 2)
// will group and weight on these values.

export const MODULE_NAME = 'graph';

export const EDGE_RELATIONS = [
  'mutual_network',
  'colleague',
  'met_at_event',
  'mutual_intro',
  'manual',
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export const EDGE_SOURCES = ['linkedin_csv', 'manual', 'event_import', 'skype_migrate'] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

export const EDGE_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

export const GRAPH_LIMITS = {
  context: 500,
  eventName: 200,
  eventLocation: 200,
  attendeeRole: 80,
} as const;

export type GraphErrorCode = 'invalid_input' | 'not_found' | 'conflict';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
  }
}

export interface GraphOptions {
  now?: Date;
}

export function resolveNow(opts: GraphOptions = {}): Date {
  return opts.now ?? new Date();
}

export function optionalText(
  value: unknown,
  max: number,
  field: string
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new GraphError('invalid_input', `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new GraphError('invalid_input', `"${field}" must be ${max} characters or fewer.`);
  }
  return trimmed === '' ? null : trimmed;
}
