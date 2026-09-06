import { MAX_PROFILE_BYTES } from "@netpro/core/src/card/types";
import { parseProfileCardJson } from "@netpro/core/src/card/validation";
import type { ProfileCard } from "@netpro/core/src/card/types";

export class CardRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardRequestError";
  }
}

/** Like Auth.js/Server Actions, respect host/protocol supplied by a trusted proxy. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site")
    return false;
  try {
    const incoming = new URL(request.url);
    const host =
      request.headers.get("x-forwarded-host") ??
      request.headers.get("host") ??
      incoming.host;
    const protocol =
      request.headers.get("x-forwarded-proto") ??
      incoming.protocol.replace(/:$/, "");
    if (
      !/^[a-z0-9.:[\]-]+$/i.test(host) ||
      !["http", "https"].includes(protocol)
    )
      return false;
    const source = new URL(origin);
    if (
      source.username ||
      source.password ||
      source.pathname !== "/" ||
      source.search ||
      source.hash
    )
      return false;
    return source.origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

/** Bound the actual stream, not only Content-Length (which can be missing/wrong). */
export async function readCardRequest(request: Request): Promise<ProfileCard> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new CardRequestError(415, "Content-Type must be application/json.");
  }
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_PROFILE_BYTES)
  ) {
    throw new CardRequestError(413, "Profile JSON must be 32 KiB or smaller.");
  }
  if (!request.body)
    throw new CardRequestError(400, "A JSON profile is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROFILE_BYTES) {
        await reader.cancel();
        throw new CardRequestError(
          413,
          "Profile JSON must be 32 KiB or smaller.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
  } catch {
    throw new CardRequestError(400, "Profile JSON must be valid UTF-8.");
  }
  return parseProfileCardJson(json);
}
