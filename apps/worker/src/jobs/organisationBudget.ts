import { checkDailyBudget, dbSpendReader, type BudgetCheck } from '@lance/agents';
import { principals, scopedDb, type Db } from '@lance/db';
import { SystemControl } from '@lance/ledger';
import { hashRecord, nowIso, type Config } from '@lance/shared';
import { eq } from 'drizzle-orm';
import { localDate, localDayStart } from '../alerts/detectors/support.js';
import { raiseAlert } from '../alerts/raise.js';

/**
 * The organisation budget (docs/plans/multi-user.md M5): today's model
 * spend across every active principal against `system_state.cost_ceiling_gbp`.
 * Each principal's spend is read through a handle scoped to them, one read
 * each, never through an unscoped read that row-level security would show
 * nothing to. `runAgent` refuses every principal's runs once this is
 * exceeded; the organisation budget guard says so to the admin.
 */

export const ORGANISATION_BUDGET_ACTOR = 'system:organisation-budget';

export interface OrganisationBudgetDeps {
  root: Db;
  config: Pick<Config, 'timeZone' | 'cost'>;
  now?: () => string;
}

/** Today's spend in USD across every active principal. */
export async function organisationSpendUsd(deps: OrganisationBudgetDeps): Promise<number> {
  const now = (deps.now ?? nowIso)();
  const since = new Date(localDayStart(localDate(now, deps.config.timeZone), deps.config.timeZone));
  const active = await deps.root
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.status, 'active'));
  let total = 0;
  for (const principal of active) {
    const scoped = scopedDb(deps.root, { principalId: principal.id });
    total += await dbSpendReader(scoped, () => since)();
  }
  return total;
}

export async function checkOrganisationBudget(deps: OrganisationBudgetDeps): Promise<BudgetCheck> {
  const organisation = await new SystemControl(deps.root).readOrganisation();
  return checkDailyBudget(() => organisationSpendUsd(deps), {
    ceilingGbp: organisation.costCeilingGbp,
    usdToGbp: deps.config.cost.usdToGbp,
    scope: 'organisation',
  });
}

/**
 * `checkOrganisationBudget` read at most once per `ttlMs`, since every
 * model run asks and the answer costs one query per principal. A run that
 * slips through inside the window overshoots by at most one run's cost.
 */
export function cachedOrganisationBudget(
  deps: OrganisationBudgetDeps,
  ttlMs = 30_000,
  clock: () => number = Date.now,
): () => Promise<BudgetCheck> {
  let cached: { at: number; check: Promise<BudgetCheck> } | null = null;
  return () => {
    const at = clock();
    if (cached === null || at - cached.at >= ttlMs) {
      const check = checkOrganisationBudget(deps);
      cached = { at, check };
      check.catch(() => {
        cached = null;
      });
    }
    return cached.check;
  };
}

const gbp = (amount: number): string => `GBP ${amount.toFixed(2)}`;

/**
 * The organisation budget guard: an organisation job that raises P1 at 80
 * per cent and P0 at the ceiling to the admin, whose handle `adminDb` is.
 * The admin is the principal whose UPN matches `config.dom.email` until
 * package 5.1 adds roles.
 */
export async function runOrganisationBudgetGuard(
  deps: OrganisationBudgetDeps & { adminDb: Db },
): Promise<BudgetCheck> {
  const now = (deps.now ?? nowIso)();
  const today = localDate(now, deps.config.timeZone);
  const check = await checkOrganisationBudget(deps);
  if (check.state === 'ok') return check;
  const provenance = [
    {
      system: 'lance' as const,
      recordId: `organisation_spend:${today}`,
      hash: hashRecord(check.spentGbp),
      observedAt: now,
    },
  ];
  const exceeded = check.state === 'exceeded';
  await raiseAlert(deps.adminDb, {
    kind: 'cost_spike',
    severity: exceeded ? 'P0' : 'P1',
    dedupeKey: `budget:organisation:${exceeded ? '100' : '80'}:${today}`,
    title: exceeded
      ? "The organisation's daily model spend has reached its ceiling"
      : "The organisation's daily model spend is at 80% of its ceiling",
    body: exceeded
      ? [
          `Model-backed agents across every principal have spent ${gbp(check.spentGbp)} against the organisation's ${gbp(check.ceilingGbp)} ceiling and are paused for everyone until midnight.`,
          'Watchers continue, so nothing stops being observed.',
          'Suggested action: raise the organisation ceiling on the Admin page, or leave it and the agents start again tomorrow.',
        ].join(' ')
      : [
          `Model-backed agents across every principal have spent ${gbp(check.spentGbp)} of the organisation's ${gbp(check.ceilingGbp)} ceiling today.`,
          'Suggested action: check the Agents page for the principal driving the spend before the remaining runs are refused for everyone.',
        ].join(' '),
    provenance,
    actor: ORGANISATION_BUDGET_ACTOR,
  });
  return check;
}
