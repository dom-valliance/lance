import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  costBarWidthPercent,
  costChartLabelIndices,
  costChartPoints,
  costChartShowsCeiling,
  costChartYFor,
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

describe('costChartPoints', () => {
  it('scales the maximum to the top of the plot', () => {
    const { points, top } = costChartPoints(
      [
        { date: '2026-09-20', gbp: 1 },
        { date: '2026-09-21', gbp: 5 },
      ],
      480,
      200,
      32,
    );
    expect(points[1]?.y).toBe(top);
  });

  it('places a single day in the horizontal middle', () => {
    const { points } = costChartPoints([{ date: '2026-09-21', gbp: 3 }], 480, 200, 32);
    expect(points[0]?.x).toBe(240);
  });

  it('returns no points for no days', () => {
    const geometry = costChartPoints([], 480, 200, 32);
    expect(geometry.points).toEqual([]);
    expect(geometry.maxGbp).toBe(0);
  });

  it('rests every point on the baseline when every day cost nothing', () => {
    const { points, bottom } = costChartPoints(
      [
        { date: '2026-09-20', gbp: 0 },
        { date: '2026-09-21', gbp: 0 },
      ],
      480,
      200,
      32,
    );
    expect(points.every((point) => point.y === bottom)).toBe(true);
  });

  it('spreads days evenly between the left and right padding', () => {
    const { points } = costChartPoints(
      [
        { date: '2026-09-19', gbp: 1 },
        { date: '2026-09-20', gbp: 1 },
        { date: '2026-09-21', gbp: 1 },
      ],
      480,
      200,
      32,
    );
    expect(points[0]?.x).toBe(32);
    expect(points[2]?.x).toBe(448);
  });
});

describe('costChartYFor', () => {
  it('places zero at the bottom of the plot', () => {
    expect(costChartYFor(0, 10, 20, 180)).toBe(180);
  });

  it('places the maximum at the top of the plot', () => {
    expect(costChartYFor(10, 10, 20, 180)).toBe(20);
  });

  it('sits on the baseline when the series has no spend to scale against', () => {
    expect(costChartYFor(5, 0, 20, 180)).toBe(180);
  });
});

describe('costChartLabelIndices', () => {
  it('labels the first, middle and last day across a full fortnight', () => {
    expect(costChartLabelIndices(14)).toEqual([0, 6, 13]);
  });

  it('collapses to one label for a single day', () => {
    expect(costChartLabelIndices(1)).toEqual([0]);
  });

  it('labels both ends without a duplicate middle for two days', () => {
    expect(costChartLabelIndices(2)).toEqual([0, 1]);
  });

  it('labels nothing for no days', () => {
    expect(costChartLabelIndices(0)).toEqual([]);
  });
});

describe('costChartShowsCeiling', () => {
  it('draws the ceiling when it falls inside the plotted range', () => {
    expect(costChartShowsCeiling(5, 10)).toBe(true);
  });

  it('hides the ceiling when it sits above the plotted maximum', () => {
    expect(costChartShowsCeiling(15, 10)).toBe(false);
  });

  it('hides the ceiling when nothing was spent to scale against', () => {
    expect(costChartShowsCeiling(5, 0)).toBe(false);
  });

  it('hides a zero ceiling', () => {
    expect(costChartShowsCeiling(0, 10)).toBe(false);
  });
});
