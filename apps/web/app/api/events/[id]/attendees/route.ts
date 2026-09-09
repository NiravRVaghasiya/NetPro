// POST / DELETE /api/events/[id]/attendees
//
// The manual half of attendance: the owner says "this person was there", so
// unlike an imported row this one links with *confirmed* `met_at_event` edges
// to everyone already on the event.
//
//   POST   { contactId | contact, role? }   link a contact (selector allowed)
//   DELETE ?contactId=... | ?contact=...    remove the attendance row
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { linkAttendee, unlinkAttendee } from "@netpro/core/src/events";
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from "@/lib/crm-request";
import {
  boundedName,
  resolveOptionalContact,
  resolveOptionalEvent,
} from "@/lib/events-request";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const scope = await requireScope("member");
    const { id } = await context.params;
    const event = await resolveOptionalEvent(conn, id, scope);
    if (!event)
      throw new CrmRequestError(404, "An event id or name is required.");
    const body = await readCrmJson(request);
    const ref = await resolveOptionalContact(
      conn,
      (body.contactId ?? body.contact) as string | undefined,
      scope,
    );
    if (!ref) {
      throw new CrmRequestError(400, "contactId or contact is required.");
    }
    const result = await linkAttendee(
      conn,
      {
        eventId: event.id,
        contactId: ref.id,
        role: boundedName(body.role, "role"),
        via: "manual",
      },
      { scope },
    );
    return crmJson(
      { event, contact: { id: ref.id, fullName: ref.fullName }, ...result },
      201,
    );
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
    const event = await resolveOptionalEvent(conn, id, scope);
    if (!event)
      throw new CrmRequestError(404, "An event id or name is required.");
    const sp = new URL(request.url).searchParams;
    const ref = await resolveOptionalContact(
      conn,
      sp.get("contactId") ?? sp.get("contact"),
      scope,
    );
    if (!ref) {
      throw new CrmRequestError(400, "contactId or contact is required.");
    }
    const result = await unlinkAttendee(
      conn,
      { eventId: event.id, contactId: ref.id },
      { scope },
    );
    return crmJson({
      event,
      contact: { id: ref.id, fullName: ref.fullName },
      ...result,
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
