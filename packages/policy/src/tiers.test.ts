import {
  ACTION_CLASSES,
  COUNTERPARTY_CLASSES,
  SYSTEMS,
  type ActionClass,
  type PolicyRule,
} from '@lance/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import { HARD_FLOORS, isHardFloorActionClass } from './hardFloors.js';
import { T0, input, rule } from './testing.js';
import { validateRule } from './validateRule.js';

/**
 * Tiered evaluation (ADR 0019): hard floors, the organisation forbid
 * ceiling, the principal's own rules, organisation defaults, then propose.
 */

const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E300H';
const ULID_BASE = '01K5S9V6QW3SWCCPVB0N0E3';

const personal = (id: string, overrides: Partial<PolicyRule> = {}): PolicyRule =>
  rule({ id: `${ULID_BASE}${id}`, principalId: PRINCIPAL, ...overrides });
const organisation = (id: string, overrides: Partial<PolicyRule> = {}): PolicyRule =>
  rule({ id: `${ULID_BASE}${id}`, principalId: null, ...overrides });

const categoriseInClient = input({
  actionClass: 'apply_category',
  counterpartyClass: 'client',
  system: 'graph',
  criticPassed: true,
});

describe('tiered evaluation', () => {
  it("lets the principal's own rule decide over an organisation default for the same cell", () => {
    const result = evaluate(categoriseInClient, [
      organisation('A01', { actionClass: 'apply_category', decision: 'propose' }),
      personal('P01', { actionClass: 'apply_category', decision: 'auto' }),
    ]);
    expect(result).toMatchObject({ decision: 'auto', tier: 'personal', ruleId: `${ULID_BASE}P01` });
  });

  it('lets a broad personal rule decide over a narrower organisation default', () => {
    const result = evaluate(categoriseInClient, [
      organisation('A02', {
        actionClass: 'apply_category',
        counterpartyClass: 'client',
        system: 'graph',
        decision: 'propose',
      }),
      personal('P02', { actionClass: 'apply_category', decision: 'auto' }),
    ]);
    expect(result.tier).toBe('personal');
    expect(result.decision).toBe('auto');
  });

  it('keeps an organisation forbid whatever a personal rule grants', () => {
    const result = evaluate(categoriseInClient, [
      organisation('A03', { actionClass: 'apply_category', decision: 'forbid' }),
      personal('P03', {
        actionClass: 'apply_category',
        counterpartyClass: 'client',
        system: 'graph',
        decision: 'auto',
      }),
    ]);
    expect(result).toMatchObject({
      decision: 'forbid',
      tier: 'organisation',
      ruleId: `${ULID_BASE}A03`,
    });
  });

  it('falls back to the organisation default when the principal has no rule for the cell', () => {
    const result = evaluate(categoriseInClient, [
      organisation('A04', { actionClass: 'apply_category', decision: 'auto' }),
      personal('P04', { actionClass: 'draft_email', decision: 'propose' }),
    ]);
    expect(result).toMatchObject({ decision: 'auto', tier: 'organisation' });
  });

  it('proposes, in the fallback tier, when no rule of either tier matches', () => {
    const result = evaluate(categoriseInClient, [
      personal('P05', { actionClass: 'draft_email', decision: 'auto' }),
    ]);
    expect(result).toMatchObject({ decision: 'propose', tier: 'fallback', ruleId: null });
  });

  it('downgrades a personal auto rule whose conditions are unmet, and names the personal tier', () => {
    const result = evaluate(input({ ...categoriseInClient, criticPassed: false }), [
      personal('P06', { actionClass: 'apply_category', decision: 'auto' }),
    ]);
    expect(result).toMatchObject({
      decision: 'propose',
      reason: 'conditions_unmet',
      tier: 'personal',
    });
  });

  it('reports the tier of a personal forbid that tightens a propose floor', () => {
    const result = evaluate(input({ actionClass: 'promote_to_shared', system: 'lance' }), [
      personal('P07', { actionClass: 'promote_to_shared', decision: 'forbid' }),
    ]);
    expect(result).toMatchObject({ decision: 'forbid', tier: 'personal', reason: 'rule_matched' });
  });

  it('holds promote_to_shared at propose, and refuses a rule that grants it auto', () => {
    const result = evaluate(input({ actionClass: 'promote_to_shared', system: 'lance' }), []);
    expect(result).toMatchObject({ decision: 'propose', tier: 'hard_floor' });
    expect(() =>
      validateRule(personal('P08', { actionClass: 'promote_to_shared', decision: 'auto' })),
    ).toThrow(/hard floor/);
  });
});

const decisionArb = fc.constantFrom('forbid' as const, 'propose' as const, 'auto' as const);
const tierArb = fc.constantFrom(null, PRINCIPAL);
const wildcard = <T extends string>(values: readonly T[]): fc.Arbitrary<T | '*'> =>
  fc.constantFrom<T | '*'>('*', ...values);

let generated = 0;
const mixedRuleArb: fc.Arbitrary<PolicyRule> = fc
  .record({
    principalId: tierArb,
    actionClass: wildcard(ACTION_CLASSES),
    counterpartyClass: wildcard(COUNTERPARTY_CLASSES),
    system: wildcard(SYSTEMS),
    decision: decisionArb,
    active: fc.boolean(),
    version: fc.integer({ min: 1, max: 3 }),
  })
  .map((fields) => {
    generated += 1;
    return rule({
      id: `${ULID_BASE}${String(generated % 1000).padStart(3, '0')}`,
      createdAt: T0,
      conditions: { requireCriticPass: false },
      ...fields,
    });
  });

const mixedInputArb = fc.record({
  actionClass: fc.constantFrom(...ACTION_CLASSES),
  counterpartyClass: fc.constantFrom(...COUNTERPARTY_CLASSES),
  system: fc.constantFrom(...SYSTEMS),
});

const matches = (candidate: PolicyRule, cell: { actionClass: ActionClass }): boolean =>
  candidate.active && (candidate.actionClass === '*' || candidate.actionClass === cell.actionClass);

describe('tiered evaluation properties', () => {
  it('never lifts a hard floor, whatever personal and organisation rules say', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ACTION_CLASSES.filter(isHardFloorActionClass)),
        fc.array(mixedRuleArb, { maxLength: 6 }),
        (actionClass, rules) => {
          const result = evaluate(input({ actionClass }), rules);
          const floor = HARD_FLOORS[actionClass];
          expect(result.decision === floor || result.decision === 'forbid').toBe(true);
          expect(result.decision).not.toBe('auto');
        },
      ),
    );
  });

  it('never resolves promote_to_shared to auto', () => {
    fc.assert(
      fc.property(fc.array(mixedRuleArb, { maxLength: 6 }), mixedInputArb, (rules, cell) => {
        const result = evaluate(input({ ...cell, actionClass: 'promote_to_shared' }), rules);
        expect(result.decision).not.toBe('auto');
      }),
    );
  });

  it('never lets a personal rule override the most specific organisation forbid', () => {
    fc.assert(
      fc.property(fc.array(mixedRuleArb, { maxLength: 6 }), mixedInputArb, (rules, cell) => {
        const organisationOnly = rules.filter((candidate) => candidate.principalId === null);
        const withoutPersonal = evaluate(input({ ...cell, criticPassed: true }), organisationOnly);
        if (withoutPersonal.decision !== 'forbid') return;
        const withPersonal = evaluate(input({ ...cell, criticPassed: true }), rules);
        expect(withPersonal.decision).toBe('forbid');
      }),
    );
  });

  it('decides by a personal rule whenever one matches and no organisation forbid stands', () => {
    fc.assert(
      fc.property(fc.array(mixedRuleArb, { maxLength: 6 }), mixedInputArb, (rules, cell) => {
        if (isHardFloorActionClass(cell.actionClass)) return;
        const result = evaluate(input({ ...cell, criticPassed: true }), rules);
        if (result.tier === 'organisation' && result.decision === 'forbid') return;
        const anyPersonal = rules.some(
          (candidate) =>
            candidate.principalId !== null &&
            matches(candidate, cell) &&
            (candidate.counterpartyClass === '*' ||
              candidate.counterpartyClass === cell.counterpartyClass) &&
            (candidate.system === '*' || candidate.system === cell.system),
        );
        expect(result.tier === 'personal').toBe(anyPersonal);
      }),
    );
  });
});
