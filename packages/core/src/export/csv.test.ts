// packages/core/src/export/csv.test.ts
import { describe, it, expect } from 'vitest';
import { exportContactsCSV } from './csv';

describe('exportContactsCSV', () => {
  it('produces a header-only CSV for an empty contact list', () => {
    const csv = exportContactsCSV([]);
    expect(csv.trim()).toBe('id,fullName,email,company,role,location,source,relationshipScore');
  });

  it('formats contact rows', () => {
    const csv = exportContactsCSV([
      { id: '1', fullName: 'Jane Doe', email: 'jane@example.com', company: 'Stripe', role: 'Engineer', location: 'SF', source: 'linkedin_csv', relationshipScore: 42 },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('1,Jane Doe,jane@example.com,Stripe,Engineer,SF,linkedin_csv,42');
  });

  it('quotes fields containing commas', () => {
    const csv = exportContactsCSV([
      { id: '1', fullName: 'Doe, Jane', email: null, company: 'Acme, Inc.', role: null, location: null, source: 'linkedin_csv', relationshipScore: 0 },
    ]);
    expect(csv).toContain('"Doe, Jane"');
    expect(csv).toContain('"Acme, Inc."');
  });
});
