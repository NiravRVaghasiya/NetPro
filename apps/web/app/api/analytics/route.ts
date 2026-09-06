import { NextResponse } from "next/server";
import { conn } from "@/lib/db";
import { getNetworkOverview } from "@netpro/core/src/analytics";

function num(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * GET /api/analytics?days=&activeDays=&months=&limit=
 * Returns the full NetworkOverview JSON the dashboard renders.
 */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;

  try {
    const overview = await getNetworkOverview(conn, {
      dormantDays: num(p.get("days")),
      activeDays: num(p.get("activeDays")),
      growthMonths: num(p.get("months")),
      limit: num(p.get("limit")),
    });
    return NextResponse.json(overview);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
