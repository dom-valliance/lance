export type BudgetState = 'ok' | 'warning' | 'exceeded';

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

/** Reads today's spend in USD; the db implementation sums agent_runs since local midnight. */
export type SpendReader = () => Promise<number>;

export async function checkDailyBudget(
  readSpendUsd: SpendReader,
  options: { ceilingGbp: number; usdToGbp: number },
): Promise<BudgetCheck> {
  const spentGbp = (await readSpendUsd()) * options.usdToGbp;
  const fraction = options.ceilingGbp <= 0 ? 1 : spentGbp / options.ceilingGbp;
  const state: BudgetState = fraction >= 1 ? 'exceeded' : fraction >= 0.8 ? 'warning' : 'ok';
  return { spentGbp, ceilingGbp: options.ceilingGbp, fraction, state };
}
