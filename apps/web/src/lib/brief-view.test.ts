import { describe, expect, it } from 'vitest';
import {
  asMorningBrief,
  audienceLabel,
  breakersLabel,
  chaseLabel,
  commitmentAgeing,
  costLine,
  counterpartyLabel,
  countLabel,
  dayBar,
  decidedLabel,
  expiresSoon,
  formatDayMonth,
  formatGbp,
  formatHours,
  freeBlockLabel,
  generatedLabel,
  interactionLabel,
  invertVisibility,
  isGenerating,
  isBeforeBriefTime,
  isBoardTime,
  isPrepExpanded,
  isTodaysBrief,
  listSentence,
  meetingLoadLabel,
  meetingMarkerLabel,
  meetingVisibility,
  nextMeetingId,
  noBriefSummary,
  overnightWindowLabel,
  tasksFooter,
} from './brief-view';

/** 21 September 2026 is in British Summer Time, so London is an hour ahead of UTC. */
const AFTERNOON = new Date('2026-09-21T15:40:00Z'); // 16:40 London
const EARLY = new Date('2026-09-21T04:52:00Z'); // 05:52 London

const meeting = (
  id: string,
  start: string,
  end: string,
  audience: 'external' | 'internal' = 'external',
) => ({ id, title: `Meeting ${id}`, start, end, audience });

describe('isBeforeBriefTime', () => {
  it('is true until the 06:30 London build and false after it', () => {
    expect(isBeforeBriefTime(EARLY)).toBe(true);
    expect(isBeforeBriefTime(new Date('2026-09-21T05:31:00Z'))).toBe(false);
  });
});

describe('isBoardTime', () => {
  it('holds the afternoon board back until 16:00 London', () => {
    expect(isBoardTime(new Date('2026-09-21T14:59:00Z'))).toBe(false);
    expect(isBoardTime(new Date('2026-09-21T15:00:00Z'))).toBe(true);
  });
});

describe('isTodaysBrief', () => {
  it('accepts a morning brief whose date is the London day of now', () => {
    expect(isTodaysBrief({ content: { date: '2026-09-21' } }, AFTERNOON)).toBe(true);
    expect(isTodaysBrief({ content: { date: '2026-09-20' } }, AFTERNOON)).toBe(false);
  });

  it('reads the London day of an afternoon board from the instant it counts from', () => {
    expect(isTodaysBrief({ content: { since: '2026-09-21T05:30:00Z' } }, AFTERNOON)).toBe(true);
    expect(isTodaysBrief({ content: { since: '2026-09-20T05:30:00Z' } }, AFTERNOON)).toBe(false);
  });

  it('rejects a missing brief and content it cannot date', () => {
    expect(isTodaysBrief(null, AFTERNOON)).toBe(false);
    expect(isTodaysBrief({ content: { headline: 'no date here' } }, AFTERNOON)).toBe(false);
  });
});

describe('asMorningBrief', () => {
  it('passes a missing brief through as null', () => {
    expect(asMorningBrief(null)).toBeNull();
  });
});

describe('dayBar', () => {
  it('places each meeting as a percentage of the 09:00 to 17:00 window', () => {
    const bar = dayBar([meeting('a', '2026-09-21T08:30:00Z', '2026-09-21T09:30:00Z')], AFTERNOON);
    expect(bar.segments).toEqual([
      {
        id: 'a',
        title: 'Meeting a',
        audience: 'external',
        leftPercent: 6.25,
        widthPercent: 12.5,
      },
    ]);
  });

  it('clamps a meeting that starts before the window opens', () => {
    const bar = dayBar([meeting('b', '2026-09-21T06:00:00Z', '2026-09-21T08:30:00Z')], AFTERNOON);
    expect(bar.segments[0]?.leftPercent).toBe(0);
    expect(bar.segments[0]?.widthPercent).toBe(6.25);
  });

  it('leaves out a meeting that does not overlap the window at all', () => {
    const bar = dayBar([meeting('c', '2026-09-21T05:00:00Z', '2026-09-21T06:00:00Z')], AFTERNOON);
    expect(bar.segments).toEqual([]);
  });

  it('marks where now falls, and nowhere when now is outside the window', () => {
    expect(dayBar([], AFTERNOON).nowPercent).toBe(95.83);
    expect(dayBar([], EARLY).nowPercent).toBeNull();
  });
});

describe('formatHours', () => {
  it('reads hours and minutes in plain words', () => {
    expect(formatHours(2.5)).toBe('2 h 30');
    expect(formatHours(8)).toBe('8 h');
    expect(formatHours(0.75)).toBe('45 min');
    expect(formatHours(2.0833333)).toBe('2 h 05');
  });
});

describe('meetingLoadLabel', () => {
  it('sets the meeting hours against the working day', () => {
    expect(meetingLoadLabel(2.5, 8)).toBe('2 h 30 of 8');
    expect(meetingLoadLabel(0, 7.5)).toBe('0 min of 7.5');
  });
});

describe('formatGbp', () => {
  it('shows pounds to two decimals', () => {
    expect(formatGbp(4.1)).toBe('£4.10');
    expect(formatGbp(15)).toBe('£15.00');
  });
});

describe('formatDayMonth', () => {
  it('gives the day and month in London', () => {
    expect(formatDayMonth('2026-09-19T10:00:00Z')).toBe('19 Sept');
  });

  it('says so when the value is not a date', () => {
    expect(formatDayMonth('not a date')).toBe('unknown date');
  });
});

describe('countLabel', () => {
  it('agrees the noun with the count', () => {
    expect(countLabel(1, 'alert')).toBe('1 alert');
    expect(countLabel(2, 'alert')).toBe('2 alerts');
    expect(countLabel(0, 'alert')).toBe('0 alerts');
  });
});

describe('audienceLabel', () => {
  it('names the counterparty class for an external meeting only', () => {
    expect(audienceLabel('external', 'client')).toBe('External, client');
    expect(audienceLabel('internal', 'self')).toBe('Internal');
  });
});

describe('interactionLabel', () => {
  it('says what the contact was and when', () => {
    expect(interactionLabel({ kind: 'mail', at: '2026-09-19T09:00:00Z' })).toBe('Mail, 19 Sept');
    expect(interactionLabel({ kind: 'transcript', at: '2026-09-19T09:00:00Z' })).toBe(
      'Transcript, 19 Sept',
    );
  });
});

describe('commitmentAgeing', () => {
  it('flags an overdue commitment in days', () => {
    expect(commitmentAgeing(null, 3)).toEqual({ label: 'overdue by 3 days', emphasis: 'overdue' });
    expect(commitmentAgeing(null, 1)).toEqual({ label: 'overdue by 1 day', emphasis: 'overdue' });
  });

  it('marks nothing overdue as due today, dated or undated', () => {
    expect(commitmentAgeing(null, 0)).toEqual({ label: 'due today', emphasis: 'soon' });
    expect(commitmentAgeing('2026-09-24T10:00:00Z', null)).toEqual({
      label: 'due 24 Sept',
      emphasis: 'none',
    });
    expect(commitmentAgeing(null, null)).toEqual({ label: 'no date', emphasis: 'none' });
  });
});

describe('chaseLabel', () => {
  it('counts the chases in words', () => {
    expect(chaseLabel(0)).toBe('not chased yet');
    expect(chaseLabel(1)).toBe('chased once');
    expect(chaseLabel(2)).toBe('chased twice');
    expect(chaseLabel(4)).toBe('chased 4 times');
  });
});

describe('counterpartyLabel', () => {
  it('adds the organisation when one is known', () => {
    expect(counterpartyLabel('Marcus Reid', 'Ostrava Partners')).toBe(
      'Marcus Reid, Ostrava Partners',
    );
    expect(counterpartyLabel('Marcus Reid', null)).toBe('Marcus Reid');
  });
});

describe('listSentence', () => {
  it('joins names the way a sentence would', () => {
    expect(listSentence([])).toBe('');
    expect(listSentence(['Marcus Reid'])).toBe('Marcus Reid');
    expect(listSentence(['Marcus Reid', 'Lena Vogt'])).toBe('Marcus Reid and Lena Vogt');
    expect(listSentence(['Marcus Reid', 'Lena Vogt', 'Ana Rees'])).toBe(
      'Marcus Reid, Lena Vogt and Ana Rees',
    );
  });
});

describe('expiresSoon', () => {
  it('is true within the last hour before expiry', () => {
    expect(expiresSoon('2026-09-21T16:05:00Z', AFTERNOON)).toBe(true);
    expect(expiresSoon('2026-09-21T18:00:00Z', AFTERNOON)).toBe(false);
  });
});

describe('tasksFooter', () => {
  it('reports the total and how many duplicates were merged', () => {
    expect(tasksFooter(12, 2)).toBe(
      '12 due or overdue in total, 2 duplicates merged across Notion and Jamie.',
    );
    expect(tasksFooter(1, 1)).toBe(
      '1 due or overdue in total, 1 duplicate merged across Notion and Jamie.',
    );
  });
});

describe('overnightWindowLabel', () => {
  it('says yesterday when the window crosses midnight', () => {
    expect(overnightWindowLabel('2026-09-20T18:00:00Z', '2026-09-21T05:30:00Z')).toBe(
      '19:00 yesterday to 06:30',
    );
  });

  it('drops yesterday when both ends fall on one London day', () => {
    expect(overnightWindowLabel('2026-09-21T04:00:00Z', '2026-09-21T05:30:00Z')).toBe(
      '05:00 to 06:30',
    );
  });
});

describe('breakersLabel', () => {
  it('says all closed, or how many are open', () => {
    expect(breakersLabel(0)).toBe('All breakers closed.');
    expect(breakersLabel(1)).toBe('1 breaker open.');
    expect(breakersLabel(3)).toBe('3 breakers open.');
  });
});

describe('costLine', () => {
  it('sets yesterday against the ceiling and adds today so far', () => {
    expect(costLine({ costYesterdayGbp: 4.12, costTodayGbp: 2.87, ceilingGbp: 15 })).toBe(
      'Yesterday cost £4.12 of the £15.00 ceiling; today so far £2.87.',
    );
  });
});

describe('decidedLabel', () => {
  it('totals the decisions and lists only the kinds that happened', () => {
    expect(decidedLabel({ approved: 2, edited: 0, rejected: 1 })).toBe(
      '3 proposals decided: 2 approved, 1 rejected.',
    );
    expect(decidedLabel({ approved: 0, edited: 0, rejected: 0 })).toBe('0 proposals decided.');
  });
});

describe('generatedLabel', () => {
  it('says today for a brief built this morning', () => {
    expect(generatedLabel('2026-09-21T05:30:00Z', AFTERNOON)).toBe('Brief generated 06:30 today');
  });

  it('dates a brief built on an earlier day', () => {
    expect(generatedLabel('2026-09-20T05:30:00Z', AFTERNOON)).toBe(
      'Brief generated 20 Sept, 06:30',
    );
  });
});

describe('isPrepExpanded', () => {
  it('expands once the prep clock has passed', () => {
    expect(isPrepExpanded({ prepExpandsAt: '2026-09-21T08:00:00Z' }, AFTERNOON)).toBe(true);
    expect(isPrepExpanded({ prepExpandsAt: '2026-09-21T17:00:00Z' }, AFTERNOON)).toBe(false);
  });
});

describe('nextMeetingId', () => {
  it('picks the first meeting that has not finished', () => {
    const meetings = [
      { id: 'a', end: '2026-09-21T09:00:00Z' },
      { id: 'b', end: '2026-09-21T16:00:00Z' },
      { id: 'c', end: '2026-09-21T17:00:00Z' },
    ];
    expect(nextMeetingId(meetings, AFTERNOON)).toBe('b');
  });

  it('answers null once the day is done', () => {
    expect(nextMeetingId([{ id: 'a', end: '2026-09-21T09:00:00Z' }], AFTERNOON)).toBeNull();
  });
});

describe('meetingVisibility', () => {
  it('opens the prep on the clock at desktop and on the next meeting at phone', () => {
    expect(meetingVisibility(true, true)).toBe('both');
    expect(meetingVisibility(true, false)).toBe('desktop');
    expect(meetingVisibility(false, true)).toBe('phone');
    expect(meetingVisibility(false, false)).toBe('none');
  });
});

describe('invertVisibility', () => {
  it('shows the summary exactly where the prep is hidden', () => {
    expect(invertVisibility('both')).toBe('none');
    expect(invertVisibility('none')).toBe('both');
    expect(invertVisibility('desktop')).toBe('phone');
    expect(invertVisibility('phone')).toBe('desktop');
  });
});

describe('meetingMarkerLabel', () => {
  it('joins the London time and the title, and says None for an empty day', () => {
    expect(meetingMarkerLabel({ start: '2026-09-21T08:30:00Z', title: 'Halden Group' })).toBe(
      '09:30, Halden Group',
    );
    expect(meetingMarkerLabel(null)).toBe('None');
  });
});

describe('freeBlockLabel', () => {
  const block = { start: '2026-09-21T09:30:00Z', end: '2026-09-21T12:00:00Z', hours: 2.5 };

  it('gives the times with the length on desktop and the times alone on the phone', () => {
    expect(freeBlockLabel(block, 'with-length')).toBe('10:30 to 13:00, 2 h 30');
    expect(freeBlockLabel(block, 'times-only')).toBe('10:30 to 13:00');
  });

  it('says None when the day has no free block', () => {
    expect(freeBlockLabel(null, 'with-length')).toBe('None');
  });
});

describe('noBriefSummary', () => {
  it('names yesterday when the last brief was the day before', () => {
    expect(noBriefSummary('2026-09-20T05:30:00Z', AFTERNOON)).toBe(
      'No brief. Last successful brief yesterday, 06:30.',
    );
  });

  it('gives the date for an older brief and a plain line when there has never been one', () => {
    expect(noBriefSummary('2026-09-17T05:30:00Z', AFTERNOON)).toBe(
      'No brief. Last successful brief 17 Sept, 06:30.',
    );
    expect(noBriefSummary(null, AFTERNOON)).toBe('No brief yet.');
  });
});

describe('isGenerating', () => {
  const queued = { at: '2026-09-21T15:41:00Z', previousGeneratedAt: '2026-09-21T05:30:00Z' };

  it('holds while the page still shows the brief that was there when the job was queued', () => {
    expect(isGenerating(queued, '2026-09-21T05:30:00Z', null)).toBe(true);
  });

  it('ends when a brief with a new generatedAt lands or the header gave up on this job', () => {
    expect(isGenerating(queued, '2026-09-21T15:41:52Z', null)).toBe(false);
    expect(isGenerating(queued, '2026-09-21T05:30:00Z', queued.at)).toBe(false);
    expect(isGenerating(queued, '2026-09-21T05:30:00Z', '2026-09-21T15:00:00Z')).toBe(true);
  });

  it('treats a first brief on an empty page the same way', () => {
    const first = { at: queued.at, previousGeneratedAt: null };
    expect(isGenerating(first, null, null)).toBe(true);
    expect(isGenerating(first, '2026-09-21T15:41:52Z', null)).toBe(false);
  });
});
