import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { conn } from "@/lib/db";
import { getProfileCardState } from "@netpro/core/src/card/repository";
import { getViewsOverview } from "@netpro/core/src/views";
import CardEditor from "./editor";
import { CardTrackingPanel } from "./tracking-panel";
import { CardViewsAnalytics } from "./analytics-panel";

export const metadata = { title: "Your profile card — NetPro" };
export const dynamic = "force-dynamic";

function publicOrigin(h: Headers): string {
  // Mirror lib/card-request.ts: trust the proxy-supplied host/proto first.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(value) ? value[0] : value)?.trim();
  return s ? s : undefined;
}

/** Analytics window from `?days=` — clamped to the 90-day retention bound. */
function analyticsDays(sp: SearchParams): number {
  const n = Number(one(sp.days));
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.trunc(n), 1), 90);
}

export default async function CardSettingsPage(props?: {
  searchParams?: Promise<SearchParams>;
}) {
  // Check before reading any draft, even when rendered in parallel with the layout.
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const h = await headers();
  const q = (await props?.searchParams) ?? {};
  const days = analyticsDays(q);
  const includeBots = one(q.bots) === "1";
  const [state, overview] = await Promise.all([
    getProfileCardState(conn),
    getViewsOverview(conn, { days, limit: 10, includeBots }),
  ]);
  return (
    <>
      <CardEditor initialState={state} />
      {/* CardEditor owns its page header + max-width container; the analytics
          and tracking panels continue inside identically shaped containers. */}
      <div className="mx-auto max-w-6xl space-y-10 pt-10">
        <CardViewsAnalytics overview={overview} days={days} includeBots={includeBots} />
        <CardTrackingPanel origin={publicOrigin(h)} />
      </div>
    </>
  );
}
