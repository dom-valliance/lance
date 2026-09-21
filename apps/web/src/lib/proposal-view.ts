/**
 * Presentation helpers shared by the proposal and ledger pages. Pure, so
 * they are tested without rendering anything.
 */

const LONDON = 'Europe/London';

/**
 * All times are stored UTC and displayed Europe/London (root CLAUDE.md).
 * tRPC sends a `Date` over the wire as an ISO string, so both are accepted.
 */
export function formatInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: LONDON,
  }).format(date);
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

const asText = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
};

/**
 * What an edit changed (spec 12: "Diff view for edited proposals"). Every
 * key of either payload is compared, so a field the edit added shows with
 * an empty original and one it emptied shows with an empty replacement.
 */
export function diffPayload(
  original: Record<string, unknown>,
  edited: Record<string, unknown> | null,
): FieldChange[] {
  if (edited === null) return [];
  const fields = [...new Set([...Object.keys(original), ...Object.keys(edited)])].sort();

  return fields
    .map((field) => ({
      field,
      before: asText(original[field]),
      after: asText(edited[field]),
    }))
    .filter((change) => change.before !== change.after);
}

/** The payload's string fields, which are the ones an edit form offers. */
export function editableFields(payload: Record<string, unknown>): [string, string][] {
  return Object.entries(payload).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

export const REJECT_REASONS = [
  { value: 'wrong_target', label: 'Wrong target' },
  { value: 'not_now', label: 'Not right now' },
  { value: 'bad_draft', label: 'Draft needs work' },
  { value: 'other', label: 'Other' },
] as const;
