import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { getContactById } from "@netpro/core/src/ai";
import OutreachComposer from "./composer";

export const metadata = {
  title: "Outreach — NetPro",
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

/**
 * /outreach — the draft composer. v2.0 Phase 3 adds deep links from
 * `/graph`: `?contactId=<who to ask>&context=…&purpose=…` pre-fills the
 * intro-request draft (the pathfinder surfaces hand off here — NetPro
 * still drafts only; a human sends).
 */
export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const q = await searchParams;
  const contactId = one(q.contactId);
  const scope = await requireScope();
  const contact = contactId
    ? await getContactById(conn, contactId, scope)
    : null;
  return (
    <div>
      <h1>AI Outreach</h1>
      <p style={{ marginTop: "0.25rem" }}>
        Drafting a one-off message? Use the composer below. Reaching out to many
        people with a personalized sequence?{" "}
        <Link href="/outreach/campaigns">Create a campaign</Link>.
      </p>
      <OutreachComposer
        initialContact={
          contact
            ? {
                id: contact.id,
                fullName: contact.fullName,
                email: contact.email,
                company: contact.company,
                role: contact.role,
              }
            : undefined
        }
        initialContext={one(q.context)}
        initialPurpose={one(q.purpose)}
      />
    </div>
  );
}
