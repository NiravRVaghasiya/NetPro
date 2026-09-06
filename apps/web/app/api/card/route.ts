import { auth } from "@/lib/auth";
import { conn } from "@/lib/db";
import {
  CardRequestError,
  isSameOriginRequest,
  readCardRequest,
} from "@/lib/card-request";
import { ProfileValidationError } from "@netpro/core/src/card/types";
import {
  getProfileCardState,
  publishProfileCard,
  saveProfileDraft,
  unpublishProfileCard,
} from "@netpro/core/src/card/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function authorize(request?: Request): Promise<Response | null> {
  // Auth.js validates the configured GitHub owner on every JWT read.
  const session = await auth();
  if (!session?.user?.id) return json({ error: "Unauthorized" }, 401);
  if (request && !isSameOriginRequest(request))
    return json({ error: "A same-origin request is required." }, 403);
  return null;
}

function unavailable(): Response {
  return json(
    { error: "Unable to access the profile card. Please try again." },
    500,
  );
}

export async function GET(): Promise<Response> {
  try {
    const denied = await authorize();
    if (denied) return denied;
    return json(await getProfileCardState(conn));
  } catch {
    return unavailable();
  }
}

async function write(request: Request, publish: boolean): Promise<Response> {
  try {
    const denied = await authorize(request);
    if (denied) return denied;
    let profile;
    try {
      profile = await readCardRequest(request);
    } catch (error) {
      if (error instanceof CardRequestError)
        return json({ error: error.message }, error.status);
      if (error instanceof ProfileValidationError)
        return json({ error: error.message }, 400);
      return json({ error: "Unable to read the JSON profile." }, 400);
    }
    const state = publish
      ? await publishProfileCard(conn, profile)
      : await saveProfileDraft(conn, profile);
    return json(state);
  } catch {
    // Storage/auth failures never echo raw errors, SQL, connection strings, or data.
    return unavailable();
  }
}

export async function PUT(request: Request): Promise<Response> {
  return write(request, false);
}

export async function POST(request: Request): Promise<Response> {
  return write(request, true);
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const denied = await authorize(request);
    if (denied) return denied;
    return json(await unpublishProfileCard(conn));
  } catch {
    return unavailable();
  }
}
