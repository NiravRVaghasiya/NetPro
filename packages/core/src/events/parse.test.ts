import { describe, expect, it } from 'vitest';
import {
  EventError,
  EVENT_LIMITS,
  normalizeEmail,
  normalizeName,
  parseEventDate,
  parseEventsCsv,
  splitAttendees,
} from './index';

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Ada@Engines.DEV ')).toBe('ada@engines.dev');
  });

  it('unwraps mailto: and angle brackets', () => {
    expect(normalizeEmail('mailto:ada@engines.dev')).toBe('ada@engines.dev');
    expect(normalizeEmail('Ada Lovelace <ada@engines.dev>')).toBe('ada@engines.dev');
  });

  it('rejects text without a dotted domain', () => {
    expect(normalizeEmail('ada@localhost')).toBeNull();
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeName('José  A. Ruiz')).toBe('jose a ruiz');
    expect(normalizeName('ADA LOVELACE')).toBe('ada lovelace');
    expect(normalizeName('  ')).toBe('');
    expect(normalizeName(null)).toBe('');
  });
});

describe('parseEventDate', () => {
  it('reads dates, datetimes and offsets', () => {
    expect(parseEventDate('2026-09-14')).toBe('2026-09-14T00:00:00.000Z');
    expect(parseEventDate('2026-09-14T09:30')).toBe('2026-09-14T09:30:00.000Z');
    expect(parseEventDate('2026-09-14 09:30:00')).toBe('2026-09-14T09:30:00.000Z');
    expect(parseEventDate('2026-09-14T09:30:00Z')).toBe('2026-09-14T09:30:00.000Z');
    expect(parseEventDate('2026-09-14T09:30:00+02:00')).toBe('2026-09-14T07:30:00.000Z');
    expect(parseEventDate('2026/09/14')).toBe('2026-09-14T00:00:00.000Z');
  });

  it('rejects impossible and ambiguous dates rather than guessing', () => {
    expect(parseEventDate('2026-02-31')).toBeNull();
    expect(parseEventDate('2026-13-01')).toBeNull();
    expect(parseEventDate('14/03/2026')).toBeNull(); // March 14th or April 3rd?
    expect(parseEventDate('next tuesday')).toBeNull();
    expect(parseEventDate('')).toBeNull();
    expect(parseEventDate(null)).toBeNull();
  });
});

describe('splitAttendees', () => {
  it('splits on comma, semicolon, pipe and newline', () => {
    const { attendees } = splitAttendees('ada@engines.dev; bob@builders.io| Cara Chen, Dee');
    expect(attendees.map((a) => a.email ?? a.name)).toEqual([
      'ada@engines.dev',
      'bob@builders.io',
      'Cara Chen',
      'Dee',
    ]);
  });

  it('deduplicates within one cell', () => {
    const { attendees } = splitAttendees('ada@engines.dev, ADA@engines.dev, Ada Lovelace');
    expect(attendees).toHaveLength(2);
  });

  it('counts unreadable email-looking tokens as skipped, not names', () => {
    const { attendees, skipped } = splitAttendees('ada@localhost, Bob Builder');
    expect(skipped).toBe(1);
    expect(attendees.map((a) => a.name)).toEqual(['Bob Builder']);
  });

  it('treats every token as a name when forced', () => {
    const { attendees } = splitAttendees('ada@engines.dev', { forceName: true });
    expect(attendees[0]).toEqual({ email: null, name: 'ada@engines.dev', role: null });
  });
});

describe('parseEventsCsv', () => {
  it('reads the documented shape', () => {
    const csv = [
      'name,location,starts_at,ends_at,attendees',
      'React Conf,Berlin,2026-09-14,2026-09-16,"ada@engines.dev; bob@builders.io"',
      'RustConf,Portland,2026-10-01,,cara@chen.dev',
    ].join('\n');
    const { rows, errors, warnings } = parseEventsCsv(csv);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'React Conf',
      location: 'Berlin',
      startsAt: '2026-09-14T00:00:00.000Z',
      endsAt: '2026-09-16T00:00:00.000Z',
      attendees: [
        { email: 'ada@engines.dev', name: null, role: null },
        { email: 'bob@builders.io', name: null, role: null },
      ],
    });
    expect(rows[1]!.endsAt).toBeNull();
  });

  it('resolves alias headers (Event Name / Start Date / Attendee Emails)', () => {
    const csv = [
      'Event Name,Start Date,Attendee Emails',
      'PyCon,2026-05-01,ada@engines.dev',
    ].join('\n');
    const { rows } = parseEventsCsv(csv);
    expect(rows[0]).toMatchObject({ name: 'PyCon', startsAt: '2026-05-01T00:00:00.000Z' });
    expect(rows[0]!.attendees[0]!.email).toBe('ada@engines.dev');
  });

  it('snake_cases and odd casing still resolve', () => {
    const csv = ['EVENT_NAME,event_location,starts_at,ends_at', 'Dev Fest,Oslo,2026-06-01,2026-06-02'].join('\n');
    const { rows } = parseEventsCsv(csv);
    expect(rows[0]!.location).toBe('Oslo');
  });

  it('accepts a names column of people, not addresses', () => {
    const csv = ['name,names', 'Local Meetup,"Ada Lovelace, Bob Builder"'].join('\n');
    const { rows } = parseEventsCsv(csv);
    expect(rows[0]!.attendees.map((a) => a.name)).toEqual(['Ada Lovelace', 'Bob Builder']);
  });

  it('reports an unreadable date as a row error and keeps the other rows', () => {
    const csv = [
      'name,starts_at',
      'Good,2026-05-01',
      'Bad,1st of May',
      'Also Good,2026-06-01',
    ].join('\n');
    const { rows, errors } = parseEventsCsv(csv);
    expect(rows.map((r) => r.name)).toEqual(['Good', 'Also Good']);
    expect(errors).toEqual([{ row: 3, reason: '"1st of May" is not a date NetPro can read (use YYYY-MM-DD).' }]);
  });

  it('rejects a row that ends before it starts', () => {
    const { rows, errors } = parseEventsCsv('name,starts_at,ends_at\nBackwards,2026-05-02,2026-05-01');
    expect(rows).toEqual([]);
    expect(errors[0]!.reason).toBe('ends before it starts');
  });

  it('skips rows with no name (blank lines are skipped before that)', () => {
    // `     ` is a whitespace-only line, which Papa drops as empty; the
    // quoted-but-empty name is a real row with no name, and is reported.
    const { rows, errors } = parseEventsCsv('name\n""\n   \nReal Event');
    expect(rows.map((r) => r.name)).toEqual(['Real Event']);
    expect(errors).toEqual([{ row: 2, reason: 'event name is required' }]);
  });

  it('warns instead of failing when an attendee entry cannot be read', () => {
    const { rows, warnings } = parseEventsCsv('name,attendees\nMeetup,"nope@, ada@engines.dev"');
    expect(rows[0]!.attendees).toHaveLength(1);
    expect(warnings).toEqual([
      { row: 2, reason: '1 unreadable attendee entry skipped.' },
    ]);
  });

  it('caps events per file and says so', () => {
    const header = 'name\n';
    const body = Array.from({ length: EVENT_LIMITS.eventsPerImport + 5 }, (_, i) => `Event ${i}`).join('\n');
    const { rows, warnings } = parseEventsCsv(header + body);
    expect(rows).toHaveLength(EVENT_LIMITS.eventsPerImport);
    expect(warnings[0]!.reason).toContain(`only the first ${EVENT_LIMITS.eventsPerImport} rows`);
  });

  it('throws when the file is unusable', () => {
    expect(() => parseEventsCsv('')).toThrow(EventError);
    expect(() => parseEventsCsv('nope,location\nSome Event,Berlin')).toThrow(/no event-name column/);
    expect(() => parseEventsCsv('name')).toThrow(/empty or missing a header row/);
  });
});
