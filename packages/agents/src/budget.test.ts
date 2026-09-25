import { describe, expect, it } from 'vitest';
import {
  budgetFraction,
  budgetState,
  BUDGET_WARNING_FRACTION,
  BudgetExceededError,
  checkDailyBudget,
} from './budget.js';

const CEILING_GBP = 15;
const USD_TO_GBP = 0.75;
/** The USD spend that buys exactly `fraction` of the ceiling at this rate. */
const usdFor = (fraction: number) => (CEILING_GBP * fraction) / USD_TO_GBP;

describe('budgetState', () => {
  it('reports ok below eighty per cent of the ceiling', () => {
    expect(budgetState(usdFor(0.79), CEILING_GBP, USD_TO_GBP)).toBe('ok');
  });

  it('reports warning at exactly eighty per cent of the ceiling', () => {
    expect(budgetState(usdFor(BUDGET_WARNING_FRACTION), CEILING_GBP, USD_TO_GBP)).toBe('warning');
  });

  it('reports warning between eighty per cent and the ceiling', () => {
    expect(budgetState(usdFor(0.999), CEILING_GBP, USD_TO_GBP)).toBe('warning');
  });

  it('reports exceeded at exactly the ceiling', () => {
    expect(budgetState(usdFor(1), CEILING_GBP, USD_TO_GBP)).toBe('exceeded');
  });

  it('reports exceeded above the ceiling', () => {
    expect(budgetState(usdFor(1.5), CEILING_GBP, USD_TO_GBP)).toBe('exceeded');
  });

  it('reports ok when nothing has been spent', () => {
    expect(budgetState(0, CEILING_GBP, USD_TO_GBP)).toBe('ok');
  });

  it('treats a ceiling of zero as already exceeded', () => {
    expect(budgetState(0, 0, USD_TO_GBP)).toBe('exceeded');
  });
});

describe('budgetFraction', () => {
  it('converts USD spend to a fraction of the sterling ceiling', () => {
    expect(budgetFraction(20, CEILING_GBP, USD_TO_GBP)).toBe(1);
  });
});

describe('checkDailyBudget', () => {
  it('returns the spend in sterling with the state the fraction implies', async () => {
    const check = await checkDailyBudget(() => Promise.resolve(usdFor(0.8)), {
      ceilingGbp: CEILING_GBP,
      usdToGbp: USD_TO_GBP,
    });
    expect(check).toEqual({
      scope: 'principal',
      spentGbp: 12,
      ceilingGbp: CEILING_GBP,
      fraction: 0.8,
      state: 'warning',
    });
  });

  it('agrees with budgetState on the same spend', async () => {
    const check = await checkDailyBudget(() => Promise.resolve(usdFor(1)), {
      ceilingGbp: CEILING_GBP,
      usdToGbp: USD_TO_GBP,
    });
    expect(check.state).toBe(budgetState(usdFor(1), CEILING_GBP, USD_TO_GBP));
  });
});

describe('BudgetExceededError', () => {
  it('names the spend, the ceiling and how to lift the pause', () => {
    const error = new BudgetExceededError({
      spentGbp: 15,
      ceilingGbp: CEILING_GBP,
      fraction: 1,
      state: 'exceeded',
    });
    expect(error.name).toBe('BudgetExceededError');
    expect(error.message).toContain('GBP 15.00');
    expect(error.message).toContain('paused');
  });
});
