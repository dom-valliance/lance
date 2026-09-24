import type { PolicyInput, PolicyRule } from '@lance/shared';

/** Test helpers. Not exported from the package index. */

export const T0 = '2026-09-21T10:00:00.000Z'; // Monday 11:00 in London (BST)

export function seedLikeId(n: number): string {
  return `0TEST${String(n).padStart(21, '0')}`;
}

export function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule {
  return {
    principalId: null,
    version: 1,
    active: true,
    actionClass: '*',
    counterpartyClass: '*',
    system: '*',
    decision: 'propose',
    createdBy: 'user:dom',
    createdAt: T0,
    rationale: 'test rule',
    ...overrides,
  };
}

export function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    actionClass: 'apply_category',
    counterpartyClass: 'client',
    system: 'graph',
    at: T0,
    stage: 'proposal',
    ...overrides,
  };
}
