/**
 * The onboarding checklist as the admin page counts it (ADR 0024,
 * docs/plans/multi-user.md M3): which steps a principal has done, read
 * from the `state_changed` events each step records, and never what was
 * entered. Foundry, step 4, arrives in Phase 7.
 *
 * Each step is done when any one of its facts is in the principal's own
 * ledger. A fact is a `payload.change` value, or `credential_migrated:<connector>`
 * for Dom's credentials copied from before ADR 0022. The notice and the
 * hours steps are recorded by package 5.5's checklist; their change names
 * are the contract with it and are listed here once.
 */

export const ONBOARDING_STEPS = [
  { step: 'notice', facts: ['data_processing_notice_accepted'] },
  { step: 'microsoft365', facts: ['graph_connected', 'credential_migrated:graph'] },
  { step: 'jamie', facts: ['jamie_connected', 'credential_migrated:jamie'] },
  { step: 'slack', facts: ['slack_linked'] },
  { step: 'hours', facts: ['working_hours_confirmed'] },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['step'];

/** Every fact any step counts, for the one query that reads them. */
export const ONBOARDING_FACTS: readonly string[] = ONBOARDING_STEPS.flatMap((entry) => [
  ...entry.facts,
]);

export interface OnboardingProgress {
  steps: { step: OnboardingStepKey; done: boolean }[];
  /** True when every step is done. */
  complete: boolean;
}

export function onboardingProgress(facts: ReadonlySet<string>): OnboardingProgress {
  const steps = ONBOARDING_STEPS.map((entry) => ({
    step: entry.step,
    done: entry.facts.some((fact) => facts.has(fact)),
  }));
  return { steps, complete: steps.every((entry) => entry.done) };
}
