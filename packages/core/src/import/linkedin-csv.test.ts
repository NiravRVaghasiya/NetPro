import { describe, it, expect } from 'vitest';
import { parseLinkedInCSV } from './linkedin-csv';

describe('parseLinkedInCSV', () => {
  it('parses a clean CSV with a header row', () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'Jane,Doe,jane@example.com,Stripe,Senior Engineer,01 Jan 2024,https://linkedin.com/in/janedoe',
    ].join('\n');

    const result = parseLinkedInCSV(csv);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Stripe',
      position: 'Senior Engineer',
      linkedinUrl: 'https://linkedin.com/in/janedoe',
      connectedOn: '01 Jan 2024',
    });
  });

  it('skips a LinkedIn export preamble before the real header row', () => {
    const csv = [
      'Notes:',
      '"When exporting your connection data, you may notice..."',
      '',
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      'John,Smith,,Google,Product Manager,15 Mar 2023,https://linkedin.com/in/johnsmith',
    ].join('\n');

    const result = parseLinkedInCSV(csv);

    expect(result).toHaveLength(1);
    expect(result[0]!.fullName).toBe('John Smith');
    expect(result[0]!.email).toBeUndefined();
  });

  it('handles quoted fields containing commas', () => {
    const csv = [
      'First Name,Last Name,Email Address,Company,Position,Connected On,URL',
      '"Chen","Wei",wei@example.com,"Acme, Inc.",Engineer,01 Jan 2024,',
    ].join('\n');

    const result = parseLinkedInCSV(csv);

    expect(result[0]!.company).toBe('Acme, Inc.');
  });

  it('returns an empty array for a CSV with only a header row', () => {
    const csv = 'First Name,Last Name,Email Address,Company,Position,Connected On,URL';
    expect(parseLinkedInCSV(csv)).toEqual([]);
  });
});
