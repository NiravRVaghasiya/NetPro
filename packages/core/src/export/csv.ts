// packages/core/src/export/csv.ts
import Papa from 'papaparse';

export interface ContactRow {
  id: string;
  fullName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  location?: string | null;
  source: string;
  relationshipScore?: number | null;
}

const COLUMNS = ['id', 'fullName', 'email', 'company', 'role', 'location', 'source', 'relationshipScore'] as const;

export function exportContactsCSV(contacts: ContactRow[]): string {
  const rows = contacts.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    email: c.email ?? '',
    company: c.company ?? '',
    role: c.role ?? '',
    location: c.location ?? '',
    source: c.source,
    relationshipScore: c.relationshipScore ?? 0,
  }));

  return Papa.unparse({ fields: [...COLUMNS], data: rows });
}
