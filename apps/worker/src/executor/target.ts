import type { ActionClass } from '@lance/shared';

/**
 * What a rule's `targetAnyOf` is compared with: the folder a move lands
 * in, named as the proposer named it. Other classes have no target
 * condition in the seed rules. Policy reads the same value when a
 * proposal is created and again before it is executed, so seed rule 4
 * (move into `AI-Filed`) can grant `auto` at both stages.
 */
export function policyTarget(
  actionClass: ActionClass,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  if (actionClass !== 'move_mail') return null;
  for (const key of ['destinationFolderName', 'destinationFolderId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
