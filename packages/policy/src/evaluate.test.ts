import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_HOURS } from './conditions.js';
import { evaluate } from './evaluate.js';
import { input, rule, seedLikeId, T0 } from './testing.js';

const autoEverything = rule({ id: seedLikeId(1), decision: 'auto' });

describe('evaluate', () => {
  it.each(['delete', 'send_email'] as const)('forbids %s whatever the rules say', (actionClass) => {
    const result = evaluate(input({ actionClass }), [autoEverything]);
    expect(result).toMatchObject({ decision: 'forbid', reason: 'hard_floor', ruleId: null });
  });

  it('caps rule_change at propose whatever the rules say', () => {
    const result = evaluate(input({ actionClass: 'rule_change', system: 'lance' }), [
      autoEverything,
    ]);
    expect(result).toMatchObject({ decision: 'propose', reason: 'hard_floor' });
  });

  it('proposes when no rule matches', () => {
    const result = evaluate(input(), [rule({ id: seedLikeId(2), actionClass: 'read' })]);
    expect(result).toMatchObject({
      decision: 'propose',
      reason: 'no_matching_rule',
      ruleId: null,
      specificity: null,
    });
  });

  it('returns a matched forbid or propose rule without checking conditions', () => {
    const forbid = rule({
      id: seedLikeId(3),
      actionClass: 'apply_category',
      decision: 'forbid',
      conditions: { maxPerDay: 0 },
    });
    expect(evaluate(input(), [forbid])).toMatchObject({
      decision: 'forbid',
      reason: 'rule_matched',
      ruleId: forbid.id,
      specificity: 1,
    });
    const propose = rule({ id: seedLikeId(4), actionClass: 'apply_category', decision: 'propose' });
    expect(evaluate(input(), [propose])).toMatchObject({
      decision: 'propose',
      reason: 'rule_matched',
      ruleId: propose.id,
    });
  });

  it('grants auto when every condition is met and reports that a critic pass is still required', () => {
    const auto = rule({ id: seedLikeId(5), actionClass: 'apply_category', decision: 'auto' });
    expect(evaluate(input(), [auto])).toEqual({
      decision: 'auto',
      reason: 'rule_matched',
      ruleId: auto.id,
      specificity: 1,
      tier: 'organisation',
      unmetConditions: [],
      requiresCriticPass: true,
    });
  });

  it('reports no critic requirement when the rule waives it', () => {
    const auto = rule({
      id: seedLikeId(6),
      actionClass: 'read',
      decision: 'auto',
      conditions: { requireCriticPass: false },
    });
    expect(evaluate(input({ actionClass: 'read' }), [auto]).requiresCriticPass).toBe(false);
  });

  it('downgrades auto to propose, never forbid, when conditions are unmet', () => {
    const auto = rule({
      id: seedLikeId(7),
      actionClass: 'apply_category',
      decision: 'auto',
      conditions: { minConfidence: 0.9 },
    });
    const result = evaluate(input({ confidence: 0.2 }), [auto]);
    expect(result).toMatchObject({
      decision: 'propose',
      reason: 'conditions_unmet',
      ruleId: auto.id,
      unmetConditions: ['minConfidence'],
    });
  });

  it('keeps the critic requirement on a downgraded result when the rule has conditions', () => {
    const auto = rule({
      id: seedLikeId(8),
      actionClass: 'apply_category',
      decision: 'auto',
      conditions: { minConfidence: 0.9, requireCriticPass: true },
    });
    expect(evaluate(input(), [auto]).requiresCriticPass).toBe(true);
  });

  it('uses the working hours passed in options', () => {
    const auto = rule({
      id: seedLikeId(9),
      actionClass: 'apply_category',
      decision: 'auto',
      conditions: { withinWorkingHours: true },
    });
    const utcHours = { ...DEFAULT_WORKING_HOURS, timeZone: 'UTC', start: '11:00', end: '12:00' };
    expect(evaluate(input({ at: '2026-09-21T10:30:00.000Z' }), [auto]).decision).toBe('auto');
    expect(
      evaluate(input({ at: '2026-09-21T10:30:00.000Z' }), [auto], { workingHours: utcHours })
        .decision,
    ).toBe('propose');
  });

  it('applies input defaults so stage is proposal when omitted', () => {
    const auto = rule({ id: seedLikeId(10), actionClass: 'apply_category', decision: 'auto' });
    const withoutStage = {
      actionClass: 'apply_category',
      counterpartyClass: 'client',
      system: 'graph',
      at: T0,
    } as const;
    expect(evaluate(withoutStage, [auto]).decision).toBe('auto');
  });

  it('prefers the most specific rule when several match', () => {
    const wide = rule({ id: seedLikeId(11), actionClass: 'apply_category', decision: 'auto' });
    const narrow = rule({
      id: seedLikeId(12),
      actionClass: 'apply_category',
      counterpartyClass: 'client',
      system: 'graph',
      decision: 'forbid',
    });
    expect(evaluate(input(), [wide, narrow])).toMatchObject({
      decision: 'forbid',
      ruleId: narrow.id,
      specificity: 3,
    });
  });
});
