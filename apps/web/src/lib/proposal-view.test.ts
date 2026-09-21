import { describe, expect, it } from 'vitest';
import { diffPayload, editableFields, formatInstant } from './proposal-view';

describe('formatInstant', () => {
  it('shows a stored UTC instant in London time', () => {
    expect(formatInstant('2026-09-21T12:00:00.000Z')).toContain('13:00');
  });

  it('accepts a Date as well as the string tRPC sends over the wire', () => {
    expect(formatInstant(new Date('2026-09-21T12:00:00.000Z'))).toBe(
      formatInstant('2026-09-21T12:00:00.000Z'),
    );
  });

  it('says so rather than throwing when the value is not a time', () => {
    expect(formatInstant('soon')).toBe('unknown time');
  });
});

describe('diffPayload', () => {
  it('returns nothing for a proposal that was never edited', () => {
    expect(diffPayload({ subject: 'Hello' }, null)).toEqual([]);
  });

  it('lists only the fields the edit changed', () => {
    const changes = diffPayload(
      { subject: 'Hello', bodyText: 'Thanks.' },
      { subject: 'Hello', bodyText: 'Thanks, Tuesday works.' },
    );

    expect(changes).toEqual([
      { field: 'bodyText', before: 'Thanks.', after: 'Thanks, Tuesday works.' },
    ]);
  });

  it('shows a field the edit added and one it emptied', () => {
    const changes = diffPayload({ subject: 'Hello' }, { subject: '', cc: 'sam@example.com' });

    expect(changes).toEqual([
      { field: 'cc', before: '', after: 'sam@example.com' },
      { field: 'subject', before: 'Hello', after: '' },
    ]);
  });
});

describe('editableFields', () => {
  it('offers the string fields and leaves the rest alone', () => {
    expect(editableFields({ subject: 'Hello', attempts: 2, flags: ['a'] })).toEqual([
      ['subject', 'Hello'],
    ]);
  });
});
