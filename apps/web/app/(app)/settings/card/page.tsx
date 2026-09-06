import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { conn } from "@/lib/db";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import CardEditor from "./editor";

export const metadata = { title: "Your profile card — NetPro" };
export const dynamic = "force-dynamic";

export default async function CardSettingsPage() {
  // Check before reading any draft, even when rendered in parallel with the layout.
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return <CardEditor initialState={await getProfileCardState(conn)} />;
}
