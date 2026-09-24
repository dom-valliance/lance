import { describe, expect, it } from 'vitest';
import {
  dayEndIso,
  dayStartIso,
  evidenceFilename,
  isStaleWatcher,
  offboardConfirmed,
  onboardingSummary,
} from '@/lib/admin-view';
import { navItemsFor, pageTitleFor } from '@/components/shell/nav';

describe('onboardingSummary', () => {
  it('counts the steps done, and says Complete when all are', () => {
    expect(
      onboardingSummary([
        { step: 'notice', done: true },
        { step: 'slack', done: false },
      ]),
    ).toBe('1 of 2 steps done');
    expect(onboardingSummary([{ step: 'notice', done: true }])).toBe('Complete');
  });
});

describe('offboardConfirmed', () => {
  it('needs the full UPN, in any case, before the form will send', () => {
    expect(offboardConfirmed(' Ann@Valliance.ai ', 'ann@valliance.ai')).toBe(true);
    expect(offboardConfirmed('ann', 'ann@valliance.ai')).toBe(false);
  });
});

describe('the evidence period', () => {
  it('runs from the start of the first day to the end of the last', () => {
    expect(dayStartIso('2026-09-01')).toBe('2026-09-01T00:00:00.000Z');
    expect(dayEndIso('2026-09-24')).toBe('2026-09-25T00:00:00.000Z');
    expect(dayStartIso('1 September')).toBeNull();
  });

  it('names the file by scope and dates', () => {
    expect(evidenceFilename('2026-09-01', '2026-09-24', null)).toBe(
      'lance-evidence-system-2026-09-01-to-2026-09-24.json',
    );
  });
});

describe('isStaleWatcher', () => {
  it('reads a watcher silent for more than six hours as stale', () => {
    expect(isStaleWatcher(361)).toBe(true);
    expect(isStaleWatcher(30)).toBe(false);
  });
});

describe('the admin navigation item', () => {
  it('is listed for a Lance.Admin and never for anyone else', () => {
    expect(navItemsFor(true).map((item) => item.href)).toContain('/admin');
    expect(navItemsFor(false).map((item) => item.href)).not.toContain('/admin');
  });

  it('titles the page on the mobile top bar', () => {
    expect(pageTitleFor('/admin')).toBe('Admin');
  });
});
