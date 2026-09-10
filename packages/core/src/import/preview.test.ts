import { describe, it, expect } from 'vitest';
import { analyzeImportRow, previewImport } from './preview';
import { parseLinkedInCSV } from './linkedin-csv';

const CSV = [
  'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
  'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
  'John,Smith,john@example.com,Vercel,PM,not a date,',
  ',,,,,,',
  'Ada,Lovelace,ada@example.com,Analytical Engines,Director,05 Mar 2023,',
].join('\n');

describe('previewImport', () => {
  it('parses the CSV and reports per-row validity without writing', () => {
    const preview = previewImport(CSV);

    expect(preview.source).toBe('linkedin_csv');
    expect(preview.totalRows).toBe(4);
    expect(preview.validRows).toBe(3);
    expect(preview.invalidRows).toBe(1);
    // Columns come from the detected header.
    expect(preview.columns).toEqual(
      expect.arrayContaining(['First Name', 'Last Name', 'Email Address']),
    );
  });

  it('keeps the preview table bounded and flags truncation', () => {
    const preview = previewImport(CSV, { limit: 2 });
    expect(preview.contacts).toHaveLength(2);
    expect(preview.truncated).toBe(true);
  });

  it('lists the same errors the importer will skip', () => {
    const preview = previewImport(CSV);
    expect(preview.issues).toEqual([{ row: 4, reason: 'missing name' }]);
    expect(preview.issuesTruncated).toBe(false);
  });

  it('normalizes preview rows exactly like runImport does', () => {
    const preview = previewImport(CSV, { limit: 10 });
    const jane = preview.contacts.find((c) => c.fullName === 'Jane Doe');
    expect(jane).toBeDefined();
    expect(jane).toMatchObject({
      valid: true,
      company: 'Stripe',
      role: 'Engineer',
      seniority: 'senior',
      email: 'jane@example.com',
      connectedOn: '01 Jan 2024',
    });
  });

  it('flags an unparsable date but still treats the row as importable', () => {
    const preview = previewImport(CSV);
    const john = preview.contacts.find((c) => c.fullName === 'John Smith');
    expect(john?.valid).toBe(true);
    expect(john?.connectedOn).toBe('not a date');
  });

  it('handles the LinkedIn Notes preamble by skipping it', () => {
    const withPreamble = [
      'Notes:',
      '',
      'You exported your connections on 01 Jan 2024.',
      '',
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,',
    ].join('\n');
    const preview = previewImport(withPreamble);
    expect(preview.totalRows).toBe(1);
    expect(preview.validRows).toBe(1);
  });

  it('returns empty results for an empty CSV', () => {
    const preview = previewImport('First Name,Last Name\n');
    expect(preview.totalRows).toBe(0);
    expect(preview.columns).toEqual(['First Name', 'Last Name']);
  });
});

describe('analyzeImportRow', () => {
  it('is the single validation path shared with runImport', () => {
    const [raw] = parseLinkedInCSV(CSV);
    const ok = analyzeImportRow(raw!, 2);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.contact).toMatchObject({
        fullName: 'Jane Doe',
        email: 'jane@example.com',
        company: 'Stripe',
        seniority: 'senior',
      });
      expect(ok.connectionDate).toBe('2024-01-01T00:00:00.000Z');
    }
  });

  it('returns a reason for a blank row', () => {
    const raw = {
      firstName: '',
      lastName: '',
      fullName: '',
      raw: {},
    };
    const bad = analyzeImportRow(raw, 4);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('missing name');
  });
});
