import { NextResponse } from 'next/server';
import type { SqliteConn, PgConn } from '@netpro/db';
import { conn } from '@/lib/db';
import { exportContactsCSV } from '@netpro/core/src/export';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') ?? 'csv';

  if (format !== 'csv') {
    return NextResponse.json({ error: `Format "${format}" is not yet supported` }, { status: 400 });
  }

  const contacts = await listContacts(conn);
  const csv = exportContactsCSV(contacts);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="contacts.csv"',
    },
  });
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function listContacts(conn: SqliteConn | PgConn) {
  if (conn.dialect === 'sqlite') {
    return conn.db.select().from(conn.schema.contacts);
  }
  return conn.db.select().from(conn.schema.contacts);
}
