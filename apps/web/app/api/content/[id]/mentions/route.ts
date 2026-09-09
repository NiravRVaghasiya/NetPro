// POST / DELETE /api/content/[id]/mentions
//
// The manual half of mentions: the owner says "this contact is in this piece
// of content" (co-authored, mentioned, reviewed…). Contact selectors accept
// an id, an email, or an exact name — ambiguity is a 400, never a guess, and
// soft-deleted contacts cannot be mentioned.
//
//   POST   { contactId | contact, context? }   link a contact (selector allowed)
//   DELETE ?contactId=... | ?contact=...       remove the mention
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  addContentMention,
  removeContentMention,
} from "@netpro/core/src/content";
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from "@/lib/crm-request";
import {
  resolveOptionalContact,
  resolveOptionalContent,
} from "@/lib/content-request";

export const runtime = "nodejs";

/** Per-mention free text — 120 chars, matching CONTENT_LIMITS.mentionContext. */
function mentionContext(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new CrmRequestError(400, "context must be a string.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > 120) {
    throw new CrmRequestError(400, "context must be 120 characters or fewer.");
  }
  return trimmed === "" ? null : trimmed;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const scope = await requireScope("member");
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id, scope);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const body = await readCrmJson(request);
    const ref = await resolveOptionalContact(
      conn,
      (body.contactId ?? body.contact) as string | undefined,
      scope,
    );
    if (!ref) {
      throw new CrmRequestError(400, "contactId or contact is required.");
    }
    const { mention, created } = await addContentMention(
      conn,
      {
        contentId: content.id,
        contactId: ref.id,
        context: mentionContext(body.context),
      },
      scope,
    );
    return crmJson({ mention, created }, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const scope = await requireScope("member");
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id, scope);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const sp = new URL(request.url).searchParams;
    const ref = await resolveOptionalContact(
      conn,
      sp.get("contactId") ?? sp.get("contact"),
      scope,
    );
    if (!ref) {
      throw new CrmRequestError(400, "contactId or contact is required.");
    }
    const result = await removeContentMention(
      conn,
      {
        contentId: content.id,
        contactId: ref.id,
      },
      scope,
    );
    return crmJson({
      mention: result,
      contact: { id: ref.id, fullName: ref.fullName },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
