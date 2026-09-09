import { NextResponse } from "next/server";
import { requireScope } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-request";
import { conn } from "@/lib/db";
import { runImport } from "@netpro/core/src/import";

export async function POST(request: Request) {
  let scope;
  try {
    scope = await requireScope("member");
  } catch (error) {
    return crmErrorResponse(error);
  }
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A CSV file is required" },
      { status: 400 },
    );
  }

  const csv = await file.text();
  const summary = await runImport(csv, conn, scope);

  return NextResponse.json(summary);
}
