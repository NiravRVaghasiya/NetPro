// packages/server/src/middleware/request-id.ts
// Lightweight request correlation id. No framework dependency.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse
): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && incoming.trim() !== ''
      ? incoming.trim().slice(0, 128)
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
