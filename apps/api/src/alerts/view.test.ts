import { describe, expect, it } from 'vitest';
import { fakeAlert } from '../test-fakes.js';
import { provenanceOf, toAlertView } from './view.js';

describe('toAlertView', () => {
  it('renders every timestamp as an ISO string', () => {
    const view = toAlertView(
      fakeAlert({
        ackedAt: new Date('2026-09-21T10:00:00.000Z'),
        mutedUntil: new Date('2026-09-22T10:00:00.000Z'),
      }),
    );

    expect(view.firstSeen).toBe('2026-09-20T09:00:00.000Z');
    expect(view.lastSeen).toBe('2026-09-21T09:00:00.000Z');
    expect(view.ackedAt).toBe('2026-09-21T10:00:00.000Z');
    expect(view.mutedUntil).toBe('2026-09-22T10:00:00.000Z');
  });

  it('leaves the ack and mute fields null on an alert nobody has touched', () => {
    const view = toAlertView(fakeAlert());

    expect(view.ackedBy).toBeNull();
    expect(view.ackedAt).toBeNull();
    expect(view.mutedUntil).toBeNull();
  });

  it('carries the count, the severity and the Slack timestamp through', () => {
    const view = toAlertView(fakeAlert({ severity: 'P0', slackTs: '1758351600.000100' }));

    expect(view.count).toBe(2);
    expect(view.severity).toBe('P0');
    expect(view.slackTs).toBe('1758351600.000100');
  });

  it('keeps the provenance the row carries', () => {
    const view = toAlertView(fakeAlert());

    expect(view.provenance).toEqual([
      { system: 'graph', recordId: 'AAMk3', hash: 'h3', observedAt: '2026-09-20T09:00:00.000Z' },
    ]);
  });
});

describe('provenanceOf', () => {
  it('drops a ref that does not parse and keeps the ones that do', () => {
    const good = {
      system: 'notion',
      recordId: '20257534',
      hash: 'h4',
      observedAt: '2026-09-20T09:00:00.000Z',
    };

    expect(provenanceOf([good, { system: 'notion' }, 'nonsense'])).toEqual([good]);
  });

  it('reads a provenance column that is not an array as no provenance', () => {
    expect(provenanceOf(null)).toEqual([]);
  });
});
