// Shared request plumbing for the CRM/follow-up API routes.
//
// The proxy is the ownership boundary (every /api route requires the owner
// session); these helpers cover what the boundary does not: bounded JSON
// bodies, and mapping the core module's CrmError codes to HTTP statuses so
// every CRM route answers validation, not-found, and conflict failures the
// same way — with no storage internals echoed to the client.
import { CrmError } from '@netpro/core/src/crm';
import { GraphError } from '@netpro/core/src/graph';
import { EventError } from '@netpro/core/src/events';

/** Interactions cap at 5000 chars of content; 16 KiB of JSON is generous headroom. */
export const MAX_CRM_BODY_BYTES = 16 * 1024;

export class CrmRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'CrmRequestError';
  }
}

export function crmJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

/** Bound the actual stream, not only Content-Length (same discipline as the card API). */
export async function readCrmJson(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    throw new CrmRequestError(415, 'Content-Type must be application/json.');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CRM_BODY_BYTES)) {
    throw new CrmRequestError(413, `Request body must be ${MAX_CRM_BODY_BYTES / 1024} KiB or smaller.`);
  }
  if (!request.body) throw new CrmRequestError(400, 'A JSON body is required.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CRM_BODY_BYTES) {
        await reader.cancel();
        throw new CrmRequestError(
          413,
          `Request body must be ${MAX_CRM_BODY_BYTES / 1024} KiB or smaller.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = new TextDecoder().decode(concat(chunks));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CrmRequestError(400, 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CrmRequestError(400, 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The three core modules share one error-code vocabulary — so should HTTP. */
type ErrorCode = CrmError['code'] | GraphError['code'] | EventError['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
};

/**
 * Map a thrown error to a response. CrmError messages are user-facing by
 * construction (the core module writes them for humans); anything else is
 * reported generically so storage/auth internals never leak.
 */
export function crmErrorResponse(error: unknown): Response {
  if (error instanceof CrmRequestError) {
    return crmJson({ error: error.message }, error.status);
  }
  if (error instanceof CrmError || error instanceof GraphError || error instanceof EventError) {
    return crmJson({ error: error.message, code: error.code }, STATUS_BY_CODE[error.code]);
  }
  return crmJson({ error: 'Unable to process the request. Please try again.' }, 500);
}

/** Parse `?limit=`/`?offset=` with sane bounds, tolerant of garbage. */
export function paginationParams(searchParams: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = Number(searchParams.get('limit') ?? '25');
  const rawOffset = Number(searchParams.get('offset') ?? '0');
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 25,
    offset: Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0,
  };
}
