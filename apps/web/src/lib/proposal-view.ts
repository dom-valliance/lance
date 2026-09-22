/**
 * Presentation helpers shared by the proposal and ledger pages. Pure, so
 * they are tested without rendering anything.
 */

import type { ActionClass, ProposalFilter } from '@/lib/filters';
import {
  ACTION_CLASS_LABELS,
  humanise,
  PROPOSAL_STATUS_LABELS,
  SYSTEM_LABELS,
} from '@/lib/humanise';
import { expiryLabel, formatTime, relativeTo } from '@/lib/time';

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

/**
 * A payload key as a reader's label: `destinationFolderName` becomes
 * "Destination folder name". `humanise` splits on underscores and hyphens,
 * so the camel case is opened up first.
 */
export const fieldLabel = (key: string): string =>
  humanise(key.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase());

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One label-and-value line of a payload read view. */
export interface PayloadField {
  name: string;
  value: string;
}

const scalar = (value: unknown, arrays: boolean): string | null => {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (arrays) {
    const values = list(value);
    return values.length === 0 ? null : values.join(', ');
  }
  return null;
};

const fieldsOf = (payload: Record<string, unknown>, arrays = false): PayloadField[] =>
  Object.entries(payload)
    .map(([key, value]) => ({ name: fieldLabel(key), value: scalar(value, arrays) }))
    .filter((field): field is PayloadField => field.value !== null);

/**
 * How one proposal's payload is read, per action class (design 7.3,
 * "payload read views"). The keys mirror what the executor reads in
 * apps/worker/src/executor/dispatch.ts: a draft carries `to`, `cc`,
 * `subject`, `bodyText` and `replyToMessageId`; a hold carries `subject`,
 * `start`, `end` and `timeZone`; a category change carries `categories`; a
 * move carries the source and destination folders; a task carries its
 * Notion fields under `input` (a patch under `patch`).
 */
export type PayloadView =
  | {
      kind: 'email';
      to: string[];
      cc: string[];
      subject: string | null;
      body: string | null;
      replyToMessageId: string | null;
    }
  | { kind: 'task'; fields: PayloadField[] }
  | {
      kind: 'hold';
      title: string | null;
      start: string | null;
      end: string | null;
      timeZone: string;
    }
  | {
      kind: 'transition';
      beforeLabel: string;
      before: string;
      afterLabel: string;
      after: string;
      messages: number;
    }
  | { kind: 'fields'; fields: PayloadField[] };

const NOT_RECORDED = 'Not recorded';

/** How many messages a mail action touches; one unless the payload names several. */
const messageCount = (payload: Record<string, unknown>): number => {
  const ids = list(payload['messageIds']);
  return ids.length === 0 ? 1 : ids.length;
};

/**
 * The view model for a payload, so the page switches on one union instead
 * of reaching into an unknown record per action class.
 */
export function payloadView(
  actionClass: ActionClass,
  payload: Record<string, unknown>,
): PayloadView {
  switch (actionClass) {
    case 'draft_email':
    case 'send_email':
      return {
        kind: 'email',
        to: list(payload['to']),
        cc: list(payload['cc']),
        subject: text(payload['subject']),
        body: text(payload['bodyText']),
        replyToMessageId: text(payload['replyToMessageId']),
      };
    case 'create_task':
    case 'update_task':
    case 'complete_task': {
      const task = record(payload['input']) ?? record(payload['patch']) ?? payload;
      return { kind: 'task', fields: fieldsOf(task, true) };
    }
    case 'create_calendar_hold':
      return {
        kind: 'hold',
        title: text(payload['subject']),
        start: text(payload['start']),
        end: text(payload['end']),
        timeZone: text(payload['timeZone']) ?? LONDON,
      };
    case 'apply_category': {
      const after = list(payload['categories']);
      return {
        kind: 'transition',
        beforeLabel: 'Before',
        before: list(payload['currentCategories']).join(', ') || 'No category',
        afterLabel: 'After',
        after: after.join(', ') || 'No category',
        messages: messageCount(payload),
      };
    }
    case 'move_mail':
      return {
        kind: 'transition',
        beforeLabel: 'From folder',
        before:
          text(payload['sourceFolderName']) ?? text(payload['sourceFolderId']) ?? NOT_RECORDED,
        afterLabel: 'To folder',
        after:
          text(payload['destinationFolderName']) ??
          text(payload['destinationFolderId']) ??
          NOT_RECORDED,
        messages: messageCount(payload),
      };
    default:
      return { kind: 'fields', fields: fieldsOf(payload) };
  }
}

/** Where a hold sits in the working day, as percentages of the 08:00 to 19:00 band. */
export interface HoldBar {
  left: number;
  width: number;
}

export const HOLD_DAY_START_HOUR = 8;
export const HOLD_DAY_END_HOUR = 19;

const DAY_START_MINUTES = HOLD_DAY_START_HOUR * 60;
const DAY_END_MINUTES = HOLD_DAY_END_HOUR * 60;
const DAY_SPAN_MINUTES = DAY_END_MINUTES - DAY_START_MINUTES;

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Minutes since London midnight, so a stored UTC instant lands on the right hour. */
const londonMinutes = (date: Date): number | null => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return (hour % 24) * 60 + minute;
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * The bar that shows a calendar hold's position within its day. Null when
 * either instant is unreadable or the hold falls wholly outside the 08:00
 * to 19:00 band the read view draws.
 */
export function holdBar(start: Date | string, end: Date | string): HoldBar | null {
  const from = toDate(start);
  const to = toDate(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  const startMinutes = londonMinutes(from);
  if (startMinutes === null) return null;
  const endMinutes = startMinutes + (to.getTime() - from.getTime()) / 60_000;

  const first = clamp(startMinutes, DAY_START_MINUTES, DAY_END_MINUTES);
  const last = clamp(endMinutes, DAY_START_MINUTES, DAY_END_MINUTES);
  if (last <= first) return null;

  const left = ((first - DAY_START_MINUTES) / DAY_SPAN_MINUTES) * 100;
  const width = ((last - first) / DAY_SPAN_MINUTES) * 100;
  return { left: round(left), width: round(Math.max(width, 1)) };
}

/** The payload keys a decision event carries, in the order they read best. */
const LEDGER_PAYLOAD_KEYS = ['action', 'from', 'to', 'note', 'reasonCode', 'status'] as const;

/**
 * A ledger event's payload as one line for the status history: "Action:
 * approve, From: pending, To: approved". Keys are humanised; values are
 * printed as the ledger stored them.
 */
export function summariseLedgerPayload(payload: unknown): string {
  const fields = record(payload);
  if (fields === null) return '';
  return LEDGER_PAYLOAD_KEYS.filter((key) => typeof fields[key] === 'string')
    .map((key) => `${fieldLabel(key)}: ${String(fields[key])}`)
    .join(', ');
}

/**
 * The 12px line under a proposal's title in the queue: why a row is held,
 * the first line of a draft, or the hours a hold would take.
 */
export function previewDetail(proposal: {
  status: ProposalStatus;
  actionClass: ActionClass;
  payload: Record<string, unknown>;
}): string | null {
  if (proposal.status === 'held') return 'Held: dry run is on';
  if (proposal.actionClass === 'draft_email' || proposal.actionClass === 'send_email') {
    const body = text(proposal.payload['bodyText']);
    return body === null ? null : (body.split('\n')[0] ?? '').trim() || null;
  }
  if (proposal.actionClass === 'create_calendar_hold') {
    const start = text(proposal.payload['start']);
    const end = text(proposal.payload['end']);
    return start === null || end === null ? null : `${formatTime(start)} to ${formatTime(end)}`;
  }
  return null;
}

/** The two lines of the queue's Expires column. */
export interface ExpiryCell {
  lead: string;
  detail: string;
}

/**
 * What the Expires column says: the countdown while a proposal is still
 * open, when it was decided once it is not, and who decided it when policy
 * did (spec 9.1, an `auto` cell executes without Dom).
 */
export function expiryCell(
  proposal: {
    status: ProposalStatus;
    expiresAt: Date | string;
    decidedAt: Date | string | null;
    policyDecision: string;
  },
  now: Date,
): ExpiryCell {
  if (proposal.status === 'pending' || proposal.status === 'held') {
    return { lead: relativeTo(proposal.expiresAt, now), detail: formatInstant(proposal.expiresAt) };
  }
  if (proposal.status === 'expired') {
    return {
      lead: `Expired ${relativeTo(proposal.expiresAt, now)}`,
      detail: formatInstant(proposal.expiresAt),
    };
  }
  if (proposal.decidedAt === null) {
    return {
      lead: PROPOSAL_STATUS_LABELS[proposal.status],
      detail: formatInstant(proposal.expiresAt),
    };
  }
  const auto = proposal.policyDecision === 'auto' && proposal.status === 'executed';
  return {
    lead: `${auto ? 'Auto' : 'Decided'} ${formatTime(proposal.decidedAt)}`,
    detail: formatInstant(proposal.decidedAt),
  };
}

/** The active proposal filters in plain words, for the "n shown" line and the phone summary. */
export function proposalFilterLabels(filter: ProposalFilter): string[] {
  const labels: string[] = [];
  if (filter.status !== undefined) labels.push(PROPOSAL_STATUS_LABELS[filter.status]);
  if (filter.actionClass !== undefined) labels.push(ACTION_CLASS_LABELS[filter.actionClass]);
  if (filter.targetSystem !== undefined) labels.push(SYSTEM_LABELS[filter.targetSystem]);
  return labels;
}

/**
 * The Proposals header sentence: how much is waiting and how long the
 * oldest of it has left. `expiryLabel` carries its own verb, so a queue
 * that has run past an expiry reads "The oldest expired yesterday."
 */
export function queueSummary(pending: { expiresAt: Date | string }[], now: Date): string {
  if (pending.length === 0) return 'Nothing pending.';
  const oldest = pending.reduce((earliest, proposal) =>
    toDate(proposal.expiresAt).getTime() < toDate(earliest.expiresAt).getTime()
      ? proposal
      : earliest,
  );
  return `${String(pending.length)} pending. The oldest ${expiryLabel(oldest.expiresAt, now)}.`;
}
