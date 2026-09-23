import { PolicyInputSchema, type Decision, type PolicyRule } from '@lance/shared';
import type { z } from 'zod';
import {
  DEFAULT_WORKING_HOURS,
  unmetConditions,
  type UnmetCondition,
  type WorkingHours,
} from './conditions.js';
import { hardFloorDecision, isHardFloorActionClass } from './hardFloors.js';
import { selectRule, specificityOf, type Specificity } from './specificity.js';

/**
 * Which tier decided (ADR 0019): a hard floor, a principal's own rule, an
 * organisation default, or the fallback when no rule matched.
 */
export type EvaluationTier = 'hard_floor' | 'personal' | 'organisation' | 'fallback';

export type EvaluationReason =
  'hard_floor' | 'no_matching_rule' | 'rule_matched' | 'conditions_unmet';

export interface EvaluationResult {
  decision: Decision;
  reason: EvaluationReason;
  ruleId: string | null;
  specificity: Specificity | null;
  /** Which tier decided (ADR 0019). */
  tier: EvaluationTier;
  unmetConditions: UnmetCondition[];
  /** True when an auto decision still needs a critic pass before execution. */
  requiresCriticPass: boolean;
}

function tierOf(rule: PolicyRule): EvaluationTier {
  return rule.principalId === null ? 'organisation' : 'personal';
}

/** Input before defaults are applied; `stage` may be omitted and defaults to proposal. */
export type PolicyInputCandidate = z.input<typeof PolicyInputSchema>;

export interface EvaluateOptions {
  workingHours?: WorkingHours;
}

/**
 * Deterministic policy evaluation (spec 6.2, in tiers per ADR 0019):
 * 1. hard floors; 2. an organisation forbid on the most specific matching
 * organisation rule; 3. the most specific active personal rule; 4. the most
 * specific active organisation rule; 5. no rule means propose. Conditions
 * unmet on auto downgrade to propose, never to forbid.
 * Writing the decision to policy_decisions is the caller's job.
 */
export function evaluate(
  rawInput: PolicyInputCandidate,
  rules: readonly PolicyRule[],
  options: EvaluateOptions = {},
): EvaluationResult {
  const input = PolicyInputSchema.parse(rawInput);

  if (isHardFloorActionClass(input.actionClass)) {
    const floor = hardFloorDecision(input.actionClass);
    // A floor at propose can still be tightened to forbid by a rule; it can
    // never be loosened to auto (validateRule rejects such rules and the
    // floor is applied here regardless).
    const stricter = floor === 'propose' ? selectRule(rules, input) : null;
    if (stricter !== null && stricter.decision === 'forbid') {
      return {
        decision: 'forbid',
        reason: 'rule_matched',
        ruleId: stricter.id,
        specificity: specificityOf(stricter),
        tier: tierOf(stricter),
        unmetConditions: [],
        requiresCriticPass: false,
      };
    }
    return {
      decision: floor,
      reason: 'hard_floor',
      ruleId: null,
      specificity: null,
      tier: 'hard_floor',
      unmetConditions: [],
      requiresCriticPass: false,
    };
  }

  // ADR 0019: an organisation forbid is a ceiling no personal rule lifts;
  // below it a principal's own rule decides, then the organisation default.
  const organisationRule = selectRule(
    rules.filter((candidate) => candidate.principalId === null),
    input,
  );
  const personalRule =
    organisationRule?.decision === 'forbid'
      ? null
      : selectRule(
          rules.filter((candidate) => candidate.principalId !== null),
          input,
        );
  const rule = personalRule ?? organisationRule;
  if (rule === null) {
    return {
      decision: 'propose',
      reason: 'no_matching_rule',
      ruleId: null,
      specificity: null,
      tier: 'fallback',
      unmetConditions: [],
      requiresCriticPass: false,
    };
  }

  if (rule.decision !== 'auto') {
    return {
      decision: rule.decision,
      reason: 'rule_matched',
      ruleId: rule.id,
      specificity: specificityOf(rule),
      tier: tierOf(rule),
      unmetConditions: [],
      requiresCriticPass: false,
    };
  }

  const unmet = unmetConditions(rule, input, options.workingHours ?? DEFAULT_WORKING_HOURS);
  const requiresCriticPass = rule.conditions?.requireCriticPass ?? true;
  if (unmet.length > 0) {
    return {
      decision: 'propose',
      reason: 'conditions_unmet',
      ruleId: rule.id,
      specificity: specificityOf(rule),
      tier: tierOf(rule),
      unmetConditions: unmet,
      requiresCriticPass,
    };
  }
  return {
    decision: 'auto',
    reason: 'rule_matched',
    ruleId: rule.id,
    specificity: specificityOf(rule),
    tier: tierOf(rule),
    unmetConditions: [],
    requiresCriticPass,
  };
}
