export type BudgetState = 'ok' | 'warning' | 'exceeded';

/**
 * Spec 13: "crossing 80% raises P1; crossing 100% pauses model-backed
 * agents". The fraction lives here so the budget-guard detector and
 * `runAgent` read the same boundary and cannot drift apart.
 */
export const BUDGET_WARNING_FRACTION = 0.8;

export interface BudgetCheck {
  spentGbp: number;
  ceilingGbp: number;
  fraction: number;
  state: BudgetState;
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly check: BudgetCheck) {
    super(
      `Daily model spend of GBP ${check.spentGbp.toFixed(2)} has reached the ceiling of GBP ${check.ceilingGbp.toFixed(2)}; model-backed agents are paused until tomorrow or until the ceiling is raised in Settings (spec 13).`,
    );
  }
}

/** Spend as a fraction of the ceiling. A ceiling of zero or less admits no spend at all. */
export function budgetFraction(spendUsd: number, ceilingGbp: number, usdToGbp: number): number {
  if (ceilingGbp <= 0) return 1;
  return (spendUsd * usdToGbp) / ceilingGbp;
}

/**
 * Where today's spend sits against the daily ceiling. Both boundaries are
 * inclusive: exactly 80 per cent of the ceiling is a `warning` and exactly
 * the ceiling is `exceeded`, so the guard fires on the crossing itself.
 */
export function budgetState(spendUsd: number, ceilingGbp: number, usdToGbp: number): BudgetState {
  const fraction = budgetFraction(spendUsd, ceilingGbp, usdToGbp);
  if (fraction >= 1) return 'exceeded';
  if (fraction >= BUDGET_WARNING_FRACTION) return 'warning';
  return 'ok';
}

/** Reads today's spend in USD; the db implementation sums agent_runs since local midnight. */
export type SpendReader = () => Promise<number>;

export async function checkDailyBudget(
  readSpendUsd: SpendReader,
  options: { ceilingGbp: number; usdToGbp: number },
): Promise<BudgetCheck> {
  const spendUsd = await readSpendUsd();
  return {
    spentGbp: spendUsd * options.usdToGbp,
    ceilingGbp: options.ceilingGbp,
    fraction: budgetFraction(spendUsd, options.ceilingGbp, options.usdToGbp),
    state: budgetState(spendUsd, options.ceilingGbp, options.usdToGbp),
  };
}
