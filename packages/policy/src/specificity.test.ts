import { describe, expect, it } from 'vitest';
import { compareRules, ruleMatches, selectRule, specificityOf } from './specificity.js';
import { input, rule, seedLikeId } from './testing.js';

describe('specificity', () => {
  it('counts exactly named dimensions', () => {
    expect(specificityOf(rule({ id: seedLikeId(1) }))).toBe(0);
    expect(specificityOf(rule({ id: seedLikeId(2), actionClass: 'read' }))).toBe(1);
    expect(specificityOf(rule({ id: seedLikeId(3), actionClass: 'read', system: 'graph' }))).toBe(
      2,
    );
    expect(
      specificityOf(
        rule({
          id: seedLikeId(4),
          actionClass: 'read',
          counterpartyClass: 'self',
          system: 'graph',
        }),
      ),
    ).toBe(3);
  });
});

describe('ruleMatches', () => {
  it('matches wildcards on every dimension', () => {
    expect(ruleMatches(rule({ id: seedLikeId(1) }), input())).toBe(true);
  });

  it('matches exact values', () => {
    const exact = rule({
      id: seedLikeId(2),
      actionClass: 'apply_category',
      counterpartyClass: 'client',
      system: 'graph',
    });
    expect(ruleMatches(exact, input())).toBe(true);
  });

  it('rejects a mismatch on any dimension', () => {
    expect(ruleMatches(rule({ id: seedLikeId(3), actionClass: 'read' }), input())).toBe(false);
    expect(ruleMatches(rule({ id: seedLikeId(4), counterpartyClass: 'self' }), input())).toBe(
      false,
    );
    expect(ruleMatches(rule({ id: seedLikeId(5), system: 'notion' }), input())).toBe(false);
  });

  it('never matches an inactive rule', () => {
    expect(ruleMatches(rule({ id: seedLikeId(6), active: false }), input())).toBe(false);
  });
});

describe('compareRules', () => {
  it('orders more specific rules first', () => {
    const wide = rule({ id: seedLikeId(1) });
    const narrow = rule({ id: seedLikeId(2), actionClass: 'read' });
    expect(compareRules(narrow, wide)).toBeLessThan(0);
    expect(compareRules(wide, narrow)).toBeGreaterThan(0);
  });

  it('breaks specificity ties by newest version', () => {
    const v1 = rule({ id: seedLikeId(1), version: 1 });
    const v2 = rule({ id: seedLikeId(2), version: 2 });
    expect(compareRules(v2, v1)).toBeLessThan(0);
  });

  it('breaks version ties by newest createdAt', () => {
    const older = rule({ id: seedLikeId(1), createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = rule({ id: seedLikeId(2), createdAt: '2026-02-01T00:00:00.000Z' });
    expect(compareRules(newer, older)).toBeLessThan(0);
  });

  it('breaks remaining ties by id so the order is total', () => {
    const a = rule({ id: seedLikeId(1) });
    const b = rule({ id: seedLikeId(2) });
    expect(compareRules(b, a)).toBeLessThan(0);
    expect(compareRules(a, a)).toBe(0);
  });
});

describe('selectRule', () => {
  it('returns null when nothing matches', () => {
    expect(selectRule([rule({ id: seedLikeId(1), actionClass: 'read' })], input())).toBeNull();
  });

  it('picks the most specific matching rule regardless of list order', () => {
    const wide = rule({ id: seedLikeId(1), decision: 'auto', actionClass: 'apply_category' });
    const narrow = rule({
      id: seedLikeId(2),
      actionClass: 'apply_category',
      counterpartyClass: 'client',
      system: 'graph',
      decision: 'forbid',
    });
    expect(selectRule([wide, narrow], input())?.id).toBe(narrow.id);
    expect(selectRule([narrow, wide], input())?.id).toBe(narrow.id);
  });
});
