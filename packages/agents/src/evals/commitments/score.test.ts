import { describe, expect, it } from 'vitest';

import {
  DESCRIPTION_SIMILARITY_THRESHOLD,
  jaccardSimilarity,
  sameCalendarDay,
  sameCounterparty,
  scoreCommitments,
  tokenise,
  type ScorableCommitment,
} from './score.js';

const commitment = (over: Partial<ScorableCommitment> = {}): ScorableCommitment => ({
  direction: 'outbound',
  description: 'Send Priya Nandra the statement of work with the fixed price',
  counterpartyName: 'Priya Nandra',
  counterpartyEmail: 'priya.nandra@harlowbrook.example.test',
  dueAt: '2026-09-25',
  ...over,
});

describe('tokenise', () => {
  it('drops stop words and punctuation', () => {
    expect([...tokenise('I will send you the statement of work.')]).toEqual([
      'send',
      'statement',
      'work',
    ]);
  });

  it('de-duplicates repeated words', () => {
    expect([...tokenise('report report REPORT')]).toEqual(['report']);
  });

  it('keeps digits', () => {
    expect([...tokenise('phase 2 proposal')]).toEqual(['phase', '2', 'proposal']);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for the same content words in a different order', () => {
    expect(jaccardSimilarity('send the risk register', 'the risk register, send it')).toBe(1);
  });

  it('returns 0 when the left side has no content words', () => {
    expect(jaccardSimilarity('the and of', 'send the risk register')).toBe(0);
  });

  it('returns 0 when the right side has no content words', () => {
    expect(jaccardSimilarity('send the risk register', 'it is with them')).toBe(0);
  });

  it('returns the overlap over the union for a partial match', () => {
    expect(jaccardSimilarity('send the risk register', 'send the risk log')).toBeCloseTo(2 / 4, 6);
  });
});

describe('sameCounterparty', () => {
  it('matches addresses case insensitively', () => {
    expect(
      sameCounterparty(
        commitment({ counterpartyEmail: 'Priya.Nandra@HarlowBrook.example.test' }),
        commitment({ counterpartyName: 'P. Nandra' }),
      ),
    ).toBe(true);
  });

  it('rejects different addresses even when the names agree', () => {
    expect(
      sameCounterparty(
        commitment(),
        commitment({ counterpartyEmail: 'priya.nandra@kestrelanalytics.example.test' }),
      ),
    ).toBe(false);
  });

  it('falls back to the normalised name when the expected address is missing', () => {
    expect(
      sameCounterparty(
        commitment({ counterpartyEmail: null, counterpartyName: 'Ben Thistle' }),
        commitment({ counterpartyName: 'ben  thistle!' }),
      ),
    ).toBe(true);
  });

  it('falls back to the name when the actual address is an empty string', () => {
    expect(
      sameCounterparty(
        commitment({ counterpartyName: 'Ben Thistle' }),
        commitment({ counterpartyEmail: '', counterpartyName: 'Ben Thistle' }),
      ),
    ).toBe(true);
  });

  it('rejects different names when an address is missing', () => {
    expect(
      sameCounterparty(
        commitment({ counterpartyEmail: null, counterpartyName: 'Ben Thistle' }),
        commitment({ counterpartyName: 'Priya Nandra' }),
      ),
    ).toBe(false);
  });

  it('treats two unnamed, unaddressed counterparties as the same', () => {
    expect(
      sameCounterparty(
        commitment({ counterpartyEmail: null, counterpartyName: null }),
        commitment({ counterpartyEmail: null, counterpartyName: null }),
      ),
    ).toBe(true);
  });
});

describe('sameCalendarDay', () => {
  it('treats two absent dates as agreeing', () => {
    expect(sameCalendarDay(null, null)).toBe(true);
  });

  it('treats an absent date against a present one as disagreeing', () => {
    expect(sameCalendarDay(null, '2026-09-25')).toBe(false);
    expect(sameCalendarDay('2026-09-25', null)).toBe(false);
  });

  it('ignores the time of day', () => {
    expect(sameCalendarDay('2026-09-25', '2026-09-25T17:00:00.000Z')).toBe(true);
  });

  it('separates adjacent days', () => {
    expect(sameCalendarDay('2026-09-25', '2026-09-26')).toBe(false);
  });

  it('parses a date that is not in ISO form', () => {
    expect(sameCalendarDay('25 September 2026', '2026-09-25')).toBe(true);
  });

  it('compares unparseable values as normalised text', () => {
    expect(sameCalendarDay('next Friday', 'NEXT FRIDAY')).toBe(true);
    expect(sameCalendarDay('next Friday', 'end of month')).toBe(false);
  });

  it('treats a blank value as absent', () => {
    expect(sameCalendarDay('  ', null)).toBe(true);
  });
});

describe('scoreCommitments', () => {
  it('scores an empty expected set against an empty extraction as perfect', () => {
    const score = scoreCommitments([], []);
    expect(score).toMatchObject({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      dueAccuracy: null,
    });
  });

  it('scores an invented commitment on an empty record as a false positive', () => {
    const score = scoreCommitments([], [commitment()]);
    expect(score).toMatchObject({ falsePositives: 1, precision: 0, recall: 0, f1: 0 });
  });

  it('scores a missed commitment as a false negative', () => {
    const score = scoreCommitments([commitment()], []);
    expect(score).toMatchObject({ falseNegatives: 1, precision: 0, recall: 0, f1: 0 });
  });

  it('matches a paraphrased description above the threshold', () => {
    const score = scoreCommitments(
      [commitment()],
      [commitment({ description: 'Send the statement of work with the fixed price to Priya' })],
    );
    expect(score.truePositives).toBe(1);
    expect(score.matches[0]?.similarity).toBeGreaterThan(DESCRIPTION_SIMILARITY_THRESHOLD);
  });

  it('refuses a description that only half overlaps', () => {
    const score = scoreCommitments(
      [commitment()],
      [commitment({ description: 'Send Priya a draft agenda for the workshop' })],
    );
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 });
  });

  it('refuses a pair whose similarity sits exactly on the threshold', () => {
    const expected = commitment({ description: 'alpha beta charlie delta' });
    const actual = commitment({ description: 'alpha beta charlie echo' });
    expect(jaccardSimilarity(expected.description, actual.description)).toBeCloseTo(
      DESCRIPTION_SIMILARITY_THRESHOLD,
      6,
    );
    expect(scoreCommitments([expected], [actual]).truePositives).toBe(0);
  });

  it('refuses a pair whose direction differs', () => {
    const score = scoreCommitments([commitment()], [commitment({ direction: 'inbound' })]);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 });
  });

  it('refuses a pair whose counterparty differs', () => {
    const score = scoreCommitments(
      [commitment()],
      [
        commitment({
          counterpartyName: 'Callum Reeve',
          counterpartyEmail: 'callum.reeve@kestrelanalytics.example.test',
        }),
      ],
    );
    expect(score.truePositives).toBe(0);
  });

  it('matches the most similar pair first when two candidates compete', () => {
    const draft = commitment({ description: 'Send Felix the draft evaluation report' });
    const final = commitment({ description: 'Send Felix the final evaluation report' });
    const score = scoreCommitments([draft, final], [final, draft]);
    expect(score.truePositives).toBe(2);
    expect(score.matches).toEqual([
      { expectedIndex: 0, actualIndex: 1, similarity: 1, dueMatch: true },
      { expectedIndex: 1, actualIndex: 0, similarity: 1, dueMatch: true },
    ]);
  });

  it('uses each extracted commitment at most once', () => {
    const first = commitment({ description: 'Circulate the risk register to the working group' });
    const second = commitment({
      description: 'Circulate the risk register to the working group again',
    });
    const score = scoreCommitments([first, second], [first]);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 1 });
    expect(score.precision).toBe(1);
    expect(score.recall).toBeCloseTo(0.5, 6);
    expect(score.f1).toBeCloseTo(2 / 3, 6);
  });

  it('counts a matched pair with the wrong due date against due accuracy only', () => {
    const score = scoreCommitments([commitment()], [commitment({ dueAt: '2026-09-26' })]);
    expect(score).toMatchObject({ truePositives: 1, f1: 1, dueMatches: 0, dueAccuracy: 0 });
  });

  it('counts two absent due dates as a due date agreement', () => {
    const score = scoreCommitments([commitment({ dueAt: null })], [commitment({ dueAt: null })]);
    expect(score).toMatchObject({ dueMatches: 1, dueAccuracy: 1 });
  });

  it('reports due accuracy over matched pairs only', () => {
    const other = commitment({
      description: 'Book the follow-up session with the operations leads',
      dueAt: '2026-10-09',
    });
    const score = scoreCommitments(
      [commitment(), other],
      [commitment({ dueAt: '2026-10-01' }), other],
    );
    expect(score.truePositives).toBe(2);
    expect(score.dueAccuracy).toBeCloseTo(0.5, 6);
  });

  it('reports the matches in expected order', () => {
    const first = commitment();
    const second = commitment({
      direction: 'inbound',
      description: 'Priya Nandra to give access to the claims data warehouse',
    });
    const score = scoreCommitments([first, second], [second, first]);
    expect(score.matches.map((match) => match.expectedIndex)).toEqual([0, 1]);
    expect(score.matches.map((match) => match.actualIndex)).toEqual([1, 0]);
  });
});
