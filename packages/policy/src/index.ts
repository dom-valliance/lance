export const PACKAGE_NAME = '@lance/policy';

export { HARD_FLOORS, hardFloorDecision, isHardFloorActionClass } from './hardFloors.js';
export type { HardFloorActionClass } from './hardFloors.js';
export { PolicyRuleValidationError, validateRule, validateRules } from './validateRule.js';
export { compareRules, ruleMatches, selectRule, specificityOf } from './specificity.js';
export type { Specificity } from './specificity.js';
export { DEFAULT_WORKING_HOURS, isWithinWorkingHours, unmetConditions } from './conditions.js';
export type { UnmetCondition, WorkingHours } from './conditions.js';
export { evaluate } from './evaluate.js';
export type {
  EvaluateOptions,
  EvaluationReason,
  EvaluationResult,
  PolicyInputCandidate,
} from './evaluate.js';
export { seedRuleId, seedRules } from './seed.js';
export type { SeedOptions } from './seed.js';
