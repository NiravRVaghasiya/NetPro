import { NextResponse } from 'next/server';
import { conn } from '@/lib/db';
import { runImport } from '@netpro/core/src/import';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'A CSV file is required' }, { status: 400 });
  }

  const csv = await file.text();
  const summary = await runImport(csv, conn);

  return NextResponse.json(summary);
}
