// apps/web/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { conn } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const start = Date.now();
  try {
    if (conn.dialect === 'sqlite') {
      conn.db.run(sql`SELECT 1`);
    } else {
      await conn.db.execute(sql`SELECT 1`);
    }
    return NextResponse.json({
      status: 'healthy',
      dialect: conn.dialect,
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'unhealthy', error: (error as Error).message },
      { status: 503 }
    );
  }
}
