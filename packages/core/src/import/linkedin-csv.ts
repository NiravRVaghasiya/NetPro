import Papa from 'papaparse';

export interface RawContact {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  position?: string;
  location?: string;
  linkedinUrl?: string;
  connectedOn?: string;
  raw: Record<string, unknown>;
}

/**
 * Parses a LinkedIn "Connections" CSV export into RawContact records.
 * Recent LinkedIn exports prepend a "Notes:" preamble before the real
 * header row — this skips any lines before the one that looks like the
 * header (contains both "First Name" and "Last Name").
 */
export function parseLinkedInCSV(csv: string): RawContact[] {
  const lines = csv.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => /first name/i.test(line) && /last name/i.test(line)
  );
  const cleaned = (headerIndex > 0 ? lines.slice(headerIndex) : lines).join('\n');

  const { data } = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: true,
  });

  return data.map((row) => {
    const firstName = row['First Name']?.trim();
    const lastName = row['Last Name']?.trim();
    return {
      firstName,
      lastName,
      fullName: `${firstName ?? ''} ${lastName ?? ''}`.trim(),
      email: row['Email Address']?.trim() || undefined,
      company: row['Company']?.trim() || undefined,
      position: row['Position']?.trim() || undefined,
      linkedinUrl: row['URL']?.trim() || undefined,
      connectedOn: row['Connected On']?.trim() || undefined,
      location: undefined,
      raw: row,
    };
  });
}
