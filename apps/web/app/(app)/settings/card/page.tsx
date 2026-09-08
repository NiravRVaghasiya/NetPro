import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { conn } from "@/lib/db";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import CardEditor from "./editor";
import { CardTrackingPanel } from "./tracking-panel";

export const metadata = { title: "Your profile card — NetPro" };
export const dynamic = "force-dynamic";

function publicOrigin(h: Headers): string {
  // Mirror lib/card-request.ts: trust the proxy-supplied host/proto first.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export default async function CardSettingsPage() {
  // Check before reading any draft, even when rendered in parallel with the layout.
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const h = await headers();
  return (
    <>
      <CardEditor initialState={await getProfileCardState(conn)} />
      {/* CardEditor owns its page header + max-width container; the tracking
          panel continues inside an identically shaped container. */}
      <div className="mx-auto max-w-6xl pt-10">
        <CardTrackingPanel origin={publicOrigin(h)} />
      </div>
    </>
  );
}
