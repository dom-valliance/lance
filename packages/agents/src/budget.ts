export type BudgetState = 'ok' | 'warning' | 'exceeded';

/**
 * Spec 13: "crossing 80% raises P1; crossing 100% pauses model-backed
 * agents". The fraction lives here so the budget-guard detector and
 * `runAgent` read the same boundary and cannot drift apart.
 */
export const BUDGET_WARNING_FRACTION = 0.8;

/**
 * Whose ceiling a check is against: one principal's own daily ceiling, or
 * the organisation's across every active principal (multi-user plan M5).
 */
export type BudgetScope = 'principal' | 'organisation';

export interface BudgetCheck {
  /** Absent means `principal`, which is every check made before Phase 5. */
  scope?: BudgetScope;
  spentGbp: number;
  ceilingGbp: number;
  fraction: number;
  state: BudgetState;
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly check: BudgetCheck) {
    super(
      check.scope === 'organisation'
        ? `The organisation's daily model spend of GBP ${check.spentGbp.toFixed(2)} across every principal has reached its ceiling of GBP ${check.ceilingGbp.toFixed(2)}; model-backed agents are paused for everyone until tomorrow or until an admin raises the organisation ceiling.`
        : `Daily model spend of GBP ${check.spentGbp.toFixed(2)} has reached the ceiling of GBP ${check.ceilingGbp.toFixed(2)}; model-backed agents are paused until tomorrow or until the ceiling is raised in Settings (spec 13).`,
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
  options: { ceilingGbp: number; usdToGbp: number; scope?: BudgetScope },
): Promise<BudgetCheck> {
  const spendUsd = await readSpendUsd();
  return {
    scope: options.scope ?? 'principal',
    spentGbp: spendUsd * options.usdToGbp,
    ceilingGbp: options.ceilingGbp,
    fraction: budgetFraction(spendUsd, options.ceilingGbp, options.usdToGbp),
    state: budgetState(spendUsd, options.ceilingGbp, options.usdToGbp),
  };
}
