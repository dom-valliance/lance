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

export type EvaluationReason =
  'hard_floor' | 'no_matching_rule' | 'rule_matched' | 'conditions_unmet';

export interface EvaluationResult {
  decision: Decision;
  reason: EvaluationReason;
  ruleId: string | null;
  specificity: Specificity | null;
  unmetConditions: UnmetCondition[];
  /** True when an auto decision still needs a critic pass before execution. */
  requiresCriticPass: boolean;
}

/** Input before defaults are applied; `stage` may be omitted and defaults to proposal. */
export type PolicyInputCandidate = z.input<typeof PolicyInputSchema>;

export interface EvaluateOptions {
  workingHours?: WorkingHours;
}

/**
 * Deterministic policy evaluation (spec 6.2):
 * 1. hard floors; 2. most specific active rule; 3. no rule means propose;
 * 4. conditions unmet on auto downgrade to propose, never to forbid.
 * Writing the decision to policy_decisions is the caller's job.
 */
export function evaluate(
  rawInput: PolicyInputCandidate,
  rules: readonly PolicyRule[],
  options: EvaluateOptions = {},
): EvaluationResult {
  const input = PolicyInputSchema.parse(rawInput);

  if (isHardFloorActionClass(input.actionClass)) {
    return {
      decision: hardFloorDecision(input.actionClass),
      reason: 'hard_floor',
      ruleId: null,
      specificity: null,
      unmetConditions: [],
      requiresCriticPass: false,
    };
  }

  const rule = selectRule(rules, input);
  if (rule === null) {
    return {
      decision: 'propose',
      reason: 'no_matching_rule',
      ruleId: null,
      specificity: null,
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
      unmetConditions: unmet,
      requiresCriticPass,
    };
  }
  return {
    decision: 'auto',
    reason: 'rule_matched',
    ruleId: rule.id,
    specificity: specificityOf(rule),
    unmetConditions: [],
    requiresCriticPass,
  };
}
