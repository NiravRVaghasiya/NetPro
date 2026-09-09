import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  CardRequestError,
  isSameOriginRequest,
  readCardRequest,
} from "@/lib/card-request";
import { ProfileValidationError } from "@netpro/core/src/card/types";
import type { WorkspaceScope } from "@netpro/core/src/workspaces";
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

async function authorize(
  request?: Request,
): Promise<{ denied: Response | null; scope: WorkspaceScope | null }> {
  // Auth.js validates the configured owner on every JWT read; membership
  // resolves the workspace the card belongs to (v3.0 Phase 2).
  let scope: WorkspaceScope;
  try {
    scope = await requireScope("member");
  } catch {
    return { denied: json({ error: "Unauthorized" }, 401), scope: null };
  }
  if (request && !isSameOriginRequest(request))
    return {
      denied: json({ error: "A same-origin request is required." }, 403),
      scope: null,
    };
  return { denied: null, scope };
}

function unavailable(): Response {
  return json(
    { error: "Unable to access the profile card. Please try again." },
    500,
  );
}

export async function GET(): Promise<Response> {
  try {
    const { denied, scope } = await authorize();
    if (denied) return denied;
    return json(await getProfileCardState(conn, scope!));
  } catch {
    return unavailable();
  }
}

async function write(request: Request, publish: boolean): Promise<Response> {
  try {
    const { denied, scope } = await authorize(request);
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
      ? await publishProfileCard(conn, profile, new Date(), scope!)
      : await saveProfileDraft(conn, profile, new Date(), scope!);
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
    const { denied, scope } = await authorize(request);
    if (denied) return denied;
    return json(await unpublishProfileCard(conn, new Date(), scope!));
  } catch {
    return unavailable();
  }
}
