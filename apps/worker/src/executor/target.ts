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

/**
 * Folders a move may never land in: a move there is a delete by another
 * name, and deletes are a hard floor at forbid (CLAUDE.md non-negotiable
 * 3). Compared case-insensitively with spaces removed, against both Graph's
 * well-known folder names and the display names Outlook shows.
 */
const DELETION_FOLDERS: ReadonlySet<string> = new Set([
  'deleteditems',
  'recoverableitemsdeletions',
  'recoverableitemspurges',
  'recoverableitemsversions',
  'recoverableitemsroot',
]);

const folderKey = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/**
 * Why a move payload must not run, or null when it may. Policy reads the
 * destination through `policyTarget` and the executor moves to it, so the
 * two must read one field: a payload naming the folder both ways could
 * pass policy under one and be moved under the other (Phase 5 review).
 */
export function moveDestinationRefusal(payload: Readonly<Record<string, unknown>>): string | null {
  const present = ['destinationFolderName', 'destinationFolderId'].filter((key) => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0;
  });
  if (present.length !== 1) {
    return present.length === 0
      ? 'A move names no destination folder; nothing was written.'
      : 'A move names its destination by both folder name and folder id; it must name it one way, so policy and the write read the same folder. Nothing was written.';
  }
  const destination = payload[present[0]!] as string;
  if (DELETION_FOLDERS.has(folderKey(destination))) {
    return `A move into ${destination} is a delete, which is forbidden in v1 whatever the rules say. Nothing was written.`;
  }
  return null;
}
