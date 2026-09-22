import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  costBarWidthPercent,
  costPercentLabel,
  isBreakerConcerning,
  isOverCeiling,
  pushesLabel,
  systemStateLabel,
  truncateTail,
} from './agents-view';

describe('systemStateLabel', () => {
  it('says running with the mode when not paused', () => {
    expect(systemStateLabel({ paused: false, pausedReason: null, mode: 'live' })).toBe(
      'Running, live mode.',
    );
  });

  it('names the reason when paused', () => {
    expect(
      systemStateLabel({ paused: true, pausedReason: 'Kill switch pulled', mode: 'live' }),
    ).toBe('Paused: Kill switch pulled');
  });

  it('says paused alone when no reason was recorded', () => {
    expect(systemStateLabel({ paused: true, pausedReason: null, mode: 'live' })).toBe('Paused.');
  });
});

describe('ageLabel', () => {
  it('reads a numeric age in plain words', () => {
    expect(ageLabel(5)).toBe('5 min ago');
    expect(ageLabel(180)).toBe('3 h ago');
  });

  it('says no runs yet when there is no age to show', () => {
    expect(ageLabel(null)).toBe('no runs yet');
  });
});

describe('truncateTail', () => {
  it('passes a short error straight through', () => {
    expect(truncateTail('Connection refused')).toBe('Connection refused');
  });

  it('truncates a long error to the limit with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = truncateTail(long);
    expect(result).toHaveLength(120);
    expect(result?.endsWith('…')).toBe(true);
  });

  it('answers null for no error', () => {
    expect(truncateTail(null)).toBeNull();
    expect(truncateTail('')).toBeNull();
  });
});

describe('costBarWidthPercent', () => {
  it('scales a fraction under budget to a percentage', () => {
    expect(costBarWidthPercent(0.27)).toBe(27);
  });

  it('clamps a fraction over budget to a full bar', () => {
    expect(costBarWidthPercent(1.4)).toBe(100);
  });

  it('clamps a negative fraction to an empty bar', () => {
    expect(costBarWidthPercent(-0.1)).toBe(0);
  });
});

describe('costPercentLabel', () => {
  it('reports the true percentage even past the ceiling', () => {
    expect(costPercentLabel(0.27)).toBe('27%');
    expect(costPercentLabel(1.4)).toBe('140%');
  });
});

describe('isOverCeiling', () => {
  it('is true once spend reaches the ceiling', () => {
    expect(isOverCeiling(1)).toBe(true);
    expect(isOverCeiling(1.2)).toBe(true);
    expect(isOverCeiling(0.99)).toBe(false);
  });
});

describe('pushesLabel', () => {
  it('agrees the noun with the count and says none plainly', () => {
    expect(pushesLabel(0)).toBe('No pushes in the last hour.');
    expect(pushesLabel(1)).toBe('1 push in the last hour.');
    expect(pushesLabel(3)).toBe('3 pushes in the last hour.');
  });
});

describe('isBreakerConcerning', () => {
  it('is false only for a closed breaker', () => {
    expect(isBreakerConcerning('closed')).toBe(false);
    expect(isBreakerConcerning('open')).toBe(true);
    expect(isBreakerConcerning('half_open')).toBe(true);
  });
});
