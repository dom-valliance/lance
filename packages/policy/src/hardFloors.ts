import type { ActionClass, Decision } from '@lance/shared';

/**
 * Hard floors are code, not configuration (CLAUDE.md non-negotiable 3).
 *
 * delete and send_email resolve to forbid in v1 whatever the rules say.
 * rule_change can never be auto (spec 6.4); it resolves to propose always.
 * promote_to_shared is the same (ADR 0017): a person decides every write
 * of one principal's evidence into the shared layer.
 */
export const HARD_FLOORS = {
  delete: 'forbid',
  send_email: 'forbid',
  rule_change: 'propose',
  promote_to_shared: 'propose',
} as const satisfies Partial<Record<ActionClass, Decision>>;

export type HardFloorActionClass = keyof typeof HARD_FLOORS;

export function isHardFloorActionClass(
  actionClass: ActionClass,
): actionClass is HardFloorActionClass {
  return Object.hasOwn(HARD_FLOORS, actionClass);
}

export function hardFloorDecision(actionClass: HardFloorActionClass): Decision {
  return HARD_FLOORS[actionClass];
}
