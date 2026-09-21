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

/**
 * Mirrors `ProposalStatus` from `@lance/shared` (packages/shared/src/enums.ts,
 * `PROPOSAL_STATUSES`). The web app cannot import `@lance/shared`, so the
 * literal union is kept here by hand.
 */
export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'rejected'
  | 'expired'
  | 'held'
  | 'executing'
  | 'executed'
  | 'failed';

/** The four decisions the Decide card can render as a form. */
export type ProposalAction = 'approve' | 'edit' | 'reject' | 'snooze';

/**
 * Which of the Decide card's forms make sense for a proposal's current
 * status, narrowed from the ledger's transition rules (spec 9.1;
 * `TRANSITIONS` in packages/ledger/src/proposals.ts) to the four actions
 * this page offers as forms:
 *
 *   approve: pending, held
 *   edit:    pending, held
 *   reject:  pending, held (also approved, edited in the ledger, as a
 *            safety net for a Slack message or browser tab left open while
 *            the status moved on)
 *   snooze:  pending
 *
 * This page always reads the status fresh from the server, so it never
 * hits that stale-UI case; once a proposal has a decision recorded
 * (approved, edited) or has moved on (rejected, expired, executing,
 * executed, failed) the decision is final here and the card explains the
 * state instead of repeating a form. The web app cannot import
 * `@lance/ledger`, so this table is kept in step with `TRANSITIONS` by
 * hand.
 */
const ALLOWED_ACTIONS: Record<ProposalStatus, ProposalAction[]> = {
  pending: ['approve', 'edit', 'reject', 'snooze'],
  held: ['approve', 'edit', 'reject'],
  approved: [],
  edited: [],
  rejected: [],
  expired: [],
  executing: [],
  executed: [],
  failed: [],
};

export function allowedActions(status: ProposalStatus): ProposalAction[] {
  return ALLOWED_ACTIONS[status];
}

/**
 * The plain-words explanation shown in the Decide card when no form
 * applies to the proposal's status (`allowedActions` returns none).
 */
const STATUS_SENTENCES: Partial<Record<ProposalStatus, string>> = {
  approved: 'Approved and waiting for the executor.',
  edited: 'Edited and waiting for the executor.',
  executing: 'Executing now.',
  executed: 'Executed.',
  rejected: 'Rejected.',
  expired: 'Expired before it was decided.',
  failed: 'Execution failed. Check the status history below.',
};

/**
 * A one-sentence, plain-words summary of a proposal's status for the
 * Decide card, or null while a form still applies (`pending`, `held`).
 */
export function statusSentence(status: ProposalStatus): string | null {
  return STATUS_SENTENCES[status] ?? null;
}
