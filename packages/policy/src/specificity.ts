import type { PolicyInput, PolicyRule } from '@lance/shared';

export type Specificity = 0 | 1 | 2 | 3;

function dimensionMatches(ruleValue: string, inputValue: string): boolean {
  return ruleValue === '*' || ruleValue === inputValue;
}

export function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  return (
    rule.active &&
    dimensionMatches(rule.actionClass, input.actionClass) &&
    dimensionMatches(rule.counterpartyClass, input.counterpartyClass) &&
    dimensionMatches(rule.system, input.system)
  );
}

/** Number of dimensions the rule names exactly. Three beats two beats one beats wildcard. */
export function specificityOf(rule: PolicyRule): Specificity {
  let count = 0;
  if (rule.actionClass !== '*') count += 1;
  if (rule.counterpartyClass !== '*') count += 1;
  if (rule.system !== '*') count += 1;
  return count as Specificity;
}

/**
 * Orders matching rules so the first entry wins: most specific first, then
 * newest version, then newest createdAt, then id descending so the order is
 * total and deterministic.
 */
export function compareRules(a: PolicyRule, b: PolicyRule): number {
  const bySpecificity = specificityOf(b) - specificityOf(a);
  if (bySpecificity !== 0) return bySpecificity;
  const byVersion = b.version - a.version;
  if (byVersion !== 0) return byVersion;
  const byCreated = b.createdAt.localeCompare(a.createdAt);
  if (byCreated !== 0) return byCreated;
  return b.id.localeCompare(a.id);
}

export function selectRule(rules: readonly PolicyRule[], input: PolicyInput): PolicyRule | null {
  const matching = rules.filter((rule) => ruleMatches(rule, input));
  if (matching.length === 0) return null;
  return matching.reduce((best, rule) => (compareRules(rule, best) < 0 ? rule : best));
}
