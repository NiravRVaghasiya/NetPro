// GET / DELETE /api/content/[id]
//
// The detail view: one piece of content with its latest snapshot, its
// snapshot count, and the live contacts it mentions (id or exact URL, so a
// link pasted with tracking junk still resolves). DELETE removes the item
// and its snapshots + mentions explicitly.
import { conn } from "@/lib/db";
import {
  deleteContentItem,
  getContentItem,
  listContentMentions,
} from "@netpro/core/src/content";
import { CrmRequestError, crmErrorResponse, crmJson } from "@/lib/crm-request";
import { resolveOptionalContent } from "@/lib/content-request";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const detail = await getContentItem(conn, content.id);
    if (!detail) {
      return crmJson(
        { error: `No content with id "${content.id}".`, code: "not_found" },
        404,
      );
    }
    const mentions = await listContentMentions(conn, content.id);
    return crmJson({ ...detail, mentions });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const removed = await deleteContentItem(conn, content.id);
    return crmJson({ removed });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
