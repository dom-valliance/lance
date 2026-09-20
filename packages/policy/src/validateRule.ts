import { PolicyRuleSchema, type PolicyRule } from '@lance/shared';
import { HARD_FLOORS, isHardFloorActionClass } from './hardFloors.js';

export class PolicyRuleValidationError extends Error {
  override readonly name = 'PolicyRuleValidationError';
}

/**
 * Parses and validates a candidate rule at write time.
 *
 * Rejects any rule that would grant auto to a hard floor action class, and any
 * auto rule that does not name its action class, because autonomy is granted
 * per cell (CLAUDE.md non-negotiable 4). Evaluation applies the floors again
 * regardless, so this is the first of two locks.
 */
export function validateRule(candidate: unknown): PolicyRule {
  const parsed = PolicyRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new PolicyRuleValidationError(`Policy rule is malformed: ${issues}`);
  }
  const rule = parsed.data;

  if (rule.decision === 'auto') {
    if (rule.actionClass === '*') {
      throw new PolicyRuleValidationError(
        `Rule ${rule.id} grants auto with a wildcard action class. Autonomy is granted per cell, so an auto rule must name its action class (CLAUDE.md non-negotiable 4).`,
      );
    }
    if (isHardFloorActionClass(rule.actionClass)) {
      throw new PolicyRuleValidationError(
        `Rule ${rule.id} grants auto to ${rule.actionClass}, which is a hard floor at ${HARD_FLOORS[rule.actionClass]} in v1. No rule can lift it (CLAUDE.md non-negotiable 3).`,
      );
    }
  }

  return rule;
}

export function validateRules(candidates: readonly unknown[]): PolicyRule[] {
  return candidates.map((candidate) => validateRule(candidate));
}
