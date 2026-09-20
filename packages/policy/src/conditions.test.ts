import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_HOURS, isWithinWorkingHours, unmetConditions } from './conditions.js';
import { input, rule, seedLikeId } from './testing.js';

describe('isWithinWorkingHours', () => {
  it('accepts a weekday inside the window in London time', () => {
    expect(isWithinWorkingHours('2026-09-21T10:00:00.000Z', DEFAULT_WORKING_HOURS)).toBe(true);
  });

  it('accepts the start minute and rejects the end minute', () => {
    expect(isWithinWorkingHours('2026-09-21T06:00:00.000Z', DEFAULT_WORKING_HOURS)).toBe(true);
    expect(isWithinWorkingHours('2026-09-21T18:00:00.000Z', DEFAULT_WORKING_HOURS)).toBe(false);
  });

  it('rejects a weekday outside the window', () => {
    expect(isWithinWorkingHours('2026-09-21T22:30:00.000Z', DEFAULT_WORKING_HOURS)).toBe(false);
  });

  it('rejects a weekend even inside the window', () => {
    expect(isWithinWorkingHours('2026-09-20T10:00:00.000Z', DEFAULT_WORKING_HOURS)).toBe(false);
  });

  it('respects the configured zone across the London and UTC offset', () => {
    const utcHours = { ...DEFAULT_WORKING_HOURS, timeZone: 'UTC' };
    expect(isWithinWorkingHours('2026-09-21T06:30:00.000Z', DEFAULT_WORKING_HOURS)).toBe(true);
    expect(isWithinWorkingHours('2026-09-21T06:30:00.000Z', utcHours)).toBe(false);
  });
});

describe('unmetConditions', () => {
  const auto = (conditions?: Parameters<typeof rule>[0]['conditions']) =>
    rule({
      id: seedLikeId(1),
      actionClass: 'apply_category',
      decision: 'auto',
      ...(conditions ? { conditions } : {}),
    });

  it('returns nothing for a rule without conditions at the proposal stage', () => {
    expect(unmetConditions(auto(), input())).toEqual([]);
  });

  it('flags withinWorkingHours outside the window', () => {
    expect(
      unmetConditions(
        auto({ withinWorkingHours: true }),
        input({ at: '2026-09-20T10:00:00.000Z' }),
      ),
    ).toEqual(['withinWorkingHours']);
    expect(unmetConditions(auto({ withinWorkingHours: true }), input())).toEqual([]);
    expect(
      unmetConditions(
        auto({ withinWorkingHours: false }),
        input({ at: '2026-09-20T10:00:00.000Z' }),
      ),
    ).toEqual([]);
  });

  it('flags maxPerDay when the count is reached and treats a missing count as zero', () => {
    expect(unmetConditions(auto({ maxPerDay: 2 }), input({ countsToday: 2 }))).toEqual([
      'maxPerDay',
    ]);
    expect(unmetConditions(auto({ maxPerDay: 2 }), input({ countsToday: 1 }))).toEqual([]);
    expect(unmetConditions(auto({ maxPerDay: 2 }), input())).toEqual([]);
  });

  it('flags maxPerHour when the count is reached and treats a missing count as zero', () => {
    expect(unmetConditions(auto({ maxPerHour: 1 }), input({ countsThisHour: 1 }))).toEqual([
      'maxPerHour',
    ]);
    expect(unmetConditions(auto({ maxPerHour: 1 }), input())).toEqual([]);
  });

  it('requires a critic pass by default: explicit failure is unmet at any stage', () => {
    expect(unmetConditions(auto(), input({ criticPassed: false }))).toEqual(['requireCriticPass']);
  });

  it('requires an explicit critic pass at the execution stage', () => {
    expect(unmetConditions(auto(), input({ stage: 'execution' }))).toEqual(['requireCriticPass']);
    expect(unmetConditions(auto(), input({ stage: 'execution', criticPassed: true }))).toEqual([]);
  });

  it('does not check the critic when requireCriticPass is false', () => {
    expect(
      unmetConditions(auto({ requireCriticPass: false }), input({ stage: 'execution' })),
    ).toEqual([]);
    expect(
      unmetConditions(auto({ requireCriticPass: false }), input({ criticPassed: false })),
    ).toEqual([]);
  });

  it('flags minConfidence when confidence is missing or too low', () => {
    expect(unmetConditions(auto({ minConfidence: 0.8 }), input())).toEqual(['minConfidence']);
    expect(unmetConditions(auto({ minConfidence: 0.8 }), input({ confidence: 0.5 }))).toEqual([
      'minConfidence',
    ]);
    expect(unmetConditions(auto({ minConfidence: 0.8 }), input({ confidence: 0.8 }))).toEqual([]);
  });

  it('flags labelsAnyOf when no input label is allowed', () => {
    expect(unmetConditions(auto({ labelsAnyOf: ['Newsletters'] }), input())).toEqual([
      'labelsAnyOf',
    ]);
    expect(
      unmetConditions(auto({ labelsAnyOf: ['Newsletters'] }), input({ labels: ['Deals'] })),
    ).toEqual(['labelsAnyOf']);
    expect(
      unmetConditions(
        auto({ labelsAnyOf: ['Newsletters'] }),
        input({ labels: ['Deals', 'Newsletters'] }),
      ),
    ).toEqual([]);
  });

  it('flags targetAnyOf when the target is missing or not allowed', () => {
    expect(unmetConditions(auto({ targetAnyOf: ['AI-Filed'] }), input())).toEqual(['targetAnyOf']);
    expect(
      unmetConditions(auto({ targetAnyOf: ['AI-Filed'] }), input({ target: 'Inbox' })),
    ).toEqual(['targetAnyOf']);
    expect(
      unmetConditions(auto({ targetAnyOf: ['AI-Filed'] }), input({ target: 'AI-Filed' })),
    ).toEqual([]);
  });

  it('reports every unmet condition in a stable order', () => {
    const result = unmetConditions(
      auto({
        withinWorkingHours: true,
        maxPerDay: 0,
        maxPerHour: 0,
        minConfidence: 1,
        labelsAnyOf: ['x'],
        targetAnyOf: ['y'],
      }),
      input({ at: '2026-09-20T10:00:00.000Z', criticPassed: false }),
    );
    expect(result).toEqual([
      'withinWorkingHours',
      'maxPerDay',
      'maxPerHour',
      'requireCriticPass',
      'minConfidence',
      'labelsAnyOf',
      'targetAnyOf',
    ]);
  });
});
