import { describe, expect, it } from 'vitest';
import { rule, seedLikeId } from './testing.js';
import { PolicyRuleValidationError, validateRule, validateRules } from './validateRule.js';

describe('validateRule', () => {
  it('rejects a malformed rule and names the bad path', () => {
    expect(() => validateRule({ ...rule({ id: seedLikeId(1) }), decision: 'maybe' })).toThrow(
      /decision/,
    );
  });

  it('reports root-level problems as (root)', () => {
    expect(() => validateRule('not an object')).toThrow(/\(root\)/);
  });

  it('rejects auto with a wildcard action class', () => {
    expect(() => validateRule(rule({ id: seedLikeId(2), decision: 'auto' }))).toThrow(
      PolicyRuleValidationError,
    );
    expect(() => validateRule(rule({ id: seedLikeId(2), decision: 'auto' }))).toThrow(/per cell/);
  });

  it.each(['delete', 'send_email', 'rule_change'] as const)(
    'rejects auto on hard floor action class %s at write time',
    (actionClass) => {
      expect(() =>
        validateRule(rule({ id: seedLikeId(3), actionClass, decision: 'auto' })),
      ).toThrow(/hard floor/);
    },
  );

  it('accepts propose and forbid rules on hard floor action classes', () => {
    expect(
      validateRule(rule({ id: seedLikeId(4), actionClass: 'delete', decision: 'forbid' })).id,
    ).toBe(seedLikeId(4));
    expect(
      validateRule(rule({ id: seedLikeId(5), actionClass: 'send_email', decision: 'propose' }))
        .decision,
    ).toBe('propose');
  });

  it('accepts a specific auto rule', () => {
    const accepted = validateRule(
      rule({ id: seedLikeId(6), actionClass: 'apply_category', system: 'graph', decision: 'auto' }),
    );
    expect(accepted.decision).toBe('auto');
  });

  it('validates a list in order', () => {
    const rules = validateRules([rule({ id: seedLikeId(7) }), rule({ id: seedLikeId(8) })]);
    expect(rules.map((r) => r.id)).toEqual([seedLikeId(7), seedLikeId(8)]);
  });
});
