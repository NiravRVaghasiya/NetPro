import { NextResponse } from "next/server";
import { conn } from "@/lib/db";
import { getNetworkOverview } from "@netpro/core/src/analytics";

function num(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * GET /api/analytics?days=&activeDays=&months=&limit=&graph=&views=&content=
 * Returns the full NetworkOverview JSON the dashboard renders — including
 * the v2.0 graph-analytics section unless `graph=0` opts out, the v2.5
 * viewer-analytics section unless `views=0` opts out, and the v2.5
 * content-tracker overview (v2.5 Phase 6) unless `content=0` opts out.
 * The opt-outs keep the payload small for API clients that only need some
 * sections; the dashboard consumes the full payload.
 */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const graph = p.get("graph");
  const views = p.get("views");
  const content = p.get("content");

  try {
    const overview = await getNetworkOverview(conn, {
      dormantDays: num(p.get("days")),
      activeDays: num(p.get("activeDays")),
      growthMonths: num(p.get("months")),
      limit: num(p.get("limit")),
      includeGraph: graph === null ? true : graph !== "0",
      includeViews: views === null ? true : views !== "0",
      includeContent: content === null ? true : content !== "0",
    });
    return NextResponse.json(overview);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
