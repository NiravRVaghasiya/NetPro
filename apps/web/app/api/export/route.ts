import { NextResponse } from "next/server";
import type { SqliteConn, PgConn } from "@netpro/db";
import { requireScope } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-request";
import { conn } from "@/lib/db";
import { exportContactsCSV } from "@netpro/core/src/export";
import {
  workspacePredicate,
  type WorkspaceScope,
} from "@netpro/core/src/workspaces/scope";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "csv";

  if (format !== "csv") {
    return NextResponse.json(
      { error: `Format "${format}" is not yet supported` },
      { status: 400 },
    );
  }

  let scope: WorkspaceScope;
  try {
    scope = await requireScope();
  } catch (error) {
    return crmErrorResponse(error);
  }
  const contacts = await listContacts(conn, scope);
  const csv = exportContactsCSV(contacts);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="contacts.csv"',
    },
  });
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function listContacts(conn: SqliteConn | PgConn, scope?: WorkspaceScope) {
  if (conn.dialect === "sqlite") {
    return conn.db
      .select()
      .from(conn.schema.contacts)
      .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
  }
  return conn.db
    .select()
    .from(conn.schema.contacts)
    .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
}
