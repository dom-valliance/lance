import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  domainOf,
  localDate,
  localDayStart,
  momentInstant,
  resolveTimeZone,
  storedProvenance,
} from './support.js';

const ZONE = 'Europe/London';

describe('localDate', () => {
  it('reads the local day, not the UTC day, across the midnight boundary', () => {
    expect(localDate('2026-06-30T23:30:00.000Z', ZONE)).toBe('2026-07-01');
    expect(localDate('2026-01-31T23:30:00.000Z', ZONE)).toBe('2026-01-31');
  });
});

describe('localDayStart', () => {
  it('returns midnight in the zone, honouring British Summer Time', () => {
    expect(localDayStart('2026-07-01', ZONE)).toBe('2026-06-30T23:00:00.000Z');
    expect(localDayStart('2026-01-31', ZONE)).toBe('2026-01-31T00:00:00.000Z');
  });
});

describe('addLocalDays', () => {
  it('walks back over a month boundary', () => {
    expect(addLocalDays('2026-09-22', -7)).toBe('2026-09-15');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalDays('2026-09-22', 1)).toBe('2026-09-23');
  });
});

describe('resolveTimeZone', () => {
  it('maps a Windows zone name to its IANA name', () => {
    expect(resolveTimeZone('GMT Standard Time', ZONE)).toBe('Europe/London');
    expect(resolveTimeZone('Pacific Standard Time', ZONE)).toBe('America/Los_Angeles');
  });

  it('keeps an IANA name as it is', () => {
    expect(resolveTimeZone('Asia/Tokyo', ZONE)).toBe('Asia/Tokyo');
  });

  it('falls back to the configured zone for a name it does not know', () => {
    expect(resolveTimeZone('Middle Earth Standard Time', ZONE)).toBe(ZONE);
  });

  it('treats a missing zone as UTC, which is what Graph sends by default', () => {
    expect(resolveTimeZone(null, ZONE)).toBe('UTC');
  });
});

describe('momentInstant', () => {
  it('reads a UTC wall clock as the instant it names', () => {
    expect(momentInstant({ dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'UTC' }, ZONE)).toBe(
      '2026-09-22T10:00:00.000Z',
    );
  });

  it('applies a Windows zone name, summer time included', () => {
    expect(
      momentInstant(
        { dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'GMT Standard Time' },
        ZONE,
      ),
    ).toBe('2026-09-22T09:00:00.000Z');
  });

  it('trusts an explicit offset over the zone name beside it', () => {
    expect(momentInstant({ dateTime: '2026-09-22T10:00:00+02:00', timeZone: 'UTC' }, ZONE)).toBe(
      '2026-09-22T08:00:00.000Z',
    );
  });

  it('returns null for a moment it cannot read', () => {
    expect(momentInstant(null, ZONE)).toBeNull();
    expect(momentInstant({ dateTime: '', timeZone: 'UTC' }, ZONE)).toBeNull();
    expect(momentInstant({ dateTime: 'not a date', timeZone: 'UTC' }, ZONE)).toBeNull();
  });
});

describe('storedProvenance', () => {
  it('keeps well-formed refs and drops the rest', () => {
    const refs = storedProvenance([
      { system: 'graph', recordId: 'm1', hash: 'h1', observedAt: '2026-09-21T08:00:00.000Z' },
      { system: 'nowhere', recordId: 'm2', hash: 'h2', observedAt: '2026-09-21T08:00:00.000Z' },
      'rubbish',
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.recordId).toBe('m1');
  });

  it('returns nothing when the column holds no array', () => {
    expect(storedProvenance(null)).toEqual([]);
  });
});

describe('domainOf', () => {
  it('lower cases the domain and ignores an address with none', () => {
    expect(domainOf('Ann@Client.Test')).toBe('client.test');
    expect(domainOf('not-an-address')).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});
