import { ACTION_CLASS_LABELS, COUNTERPARTY_LABELS, humanise, SYSTEM_LABELS } from '@/lib/humanise';
import {
  type ActionClass,
  type CounterpartyClass,
  type LedgerKind,
  type SourceSystem,
  SOURCE_SYSTEMS,
} from '@/lib/filters';
import { REJECT_REASONS } from '@/lib/proposal-view';

/**
 * What the Ledger pages need from a ledger event, and the plain-words line
 * each row shows. The api returns the whole `ledger_events` row; these
 * helpers read the handful of columns the design renders, so they stay
 * testable without a tRPC client.
 */

const LONDON = 'Europe/London';
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Structurally what a `LedgerEventRow` gives us. `ts` arrives as an ISO
 * string over the wire although the row type calls it a `Date`, so both
 * are accepted.
 */
export interface LedgerEventView {
  id: string;
  ts: Date | string;
  actor: string;
  kind: LedgerKind;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  correlationId: string;
  /** Optional because a retention run nulls it and the api's row type says so. */
  payload?: unknown;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** "21 Sept 2026, 14:05:41". Seconds matter in an audit trail, so the ledger keeps them. */
export function formatInstantWithSeconds(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: LONDON,
  }).format(date);
}

/** "14:05:41", for the narrow ledger table where the date would not fit. */
export function formatTimeWithSeconds(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', timeZone: LONDON }).format(date);
}

/**
 * How long after the first event a trail event landed: "3 s", "1 min 49 s",
 * "4 h 48 min". Seconds below a minute, minutes and seconds below an hour,
 * hours and minutes above it.
 */
export function formatDelta(ms: number): string {
  const total = Math.max(0, Math.round(Math.abs(ms) / SECOND_MS));
  if (total * SECOND_MS < MINUTE_MS) return `${String(total)} s`;
  if (total * SECOND_MS < HOUR_MS) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

/** The known source system a column value names, or null for a value we have no label for. */
export function sourceSystemOf(value: string | null): SourceSystem | null {
  if (value === null) return null;
  return (SOURCE_SYSTEMS as readonly string[]).includes(value) ? (value as SourceSystem) : null;
}

/** The label for a source system column, humanising anything the enum does not cover. */
export function sourceSystemLabel(value: string | null): string {
  const system = sourceSystemOf(value);
  if (system !== null) return SYSTEM_LABELS[system];
  return value === null ? 'none' : humanise(value);
}

const record = (payload: unknown): Record<string, unknown> | null =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;

const str = (fields: Record<string, unknown>, key: string): string | null => {
  const value = fields[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const num = (fields: Record<string, unknown>, key: string): number | null => {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** The proposal a ledger event is about, when its payload names one. */
export function proposalIdIn(payload: unknown): string | null {
  const fields = record(payload);
  return fields === null ? null : str(fields, 'proposalId');
}

/** The source record's own link, when a watcher recorded one. */
export function recordUrlIn(payload: unknown): string | null {
  const fields = record(payload);
  if (fields === null) return null;
  const url = str(fields, 'url');
  return url !== null && /^https?:\/\//.test(url) ? url : null;
}

const REJECT_REASON_LABELS: Record<string, string> = Object.fromEntries(
  REJECT_REASONS.map((reason) => [reason.value, reason.label.toLowerCase()]),
);

const DECISION_VERBS: Record<string, string> = {
  approve: 'Approved',
  reject: 'Rejected',
  edit: 'Edited',
  snooze: 'Snoozed',
  expire: 'Expired',
  hold: 'Held',
};

/** The keys that hold a sentence a reader wants, in the order they read best. */
const DESCRIPTIVE_KEYS = [
  'summary',
  'subject',
  'title',
  'description',
  'preview',
  'message',
  'note',
  'reason',
] as const;

const actionClassLabel = (value: string | null): string | null => {
  if (value === null) return null;
  return ACTION_CLASS_LABELS[value as ActionClass] ?? humanise(value);
};

const counterpartyLabel = (value: string | null): string | null => {
  if (value === null) return null;
  return (COUNTERPARTY_LABELS[value as CounterpartyClass] ?? humanise(value)).toLowerCase();
};

function decidedDetail(fields: Record<string, unknown>): string {
  const action = str(fields, 'action');
  const verb =
    action === null
      ? humanise(str(fields, 'status') ?? '')
      : (DECISION_VERBS[action] ?? humanise(action));
  const reasonCode = str(fields, 'reasonCode');
  if (reasonCode !== null) {
    return `${verb}: ${REJECT_REASON_LABELS[reasonCode] ?? humanise(reasonCode).toLowerCase()}`;
  }
  const note = str(fields, 'note');
  if (note !== null) return `${verb}: ${note}`;
  return verb;
}

function executedDetail(fields: Record<string, unknown>, event: LedgerEventView): string {
  const summary = str(fields, 'summary') ?? str(fields, 'result');
  if (summary !== null) return summary;
  const action = actionClassLabel(str(fields, 'actionClass'));
  if (action === null) return event.sourceRecordId ?? '';
  return event.sourceRecordId === null ? action : `${action} on ${event.sourceRecordId}`;
}

function proposedDetail(fields: Record<string, unknown>): string {
  const action = actionClassLabel(str(fields, 'actionClass'));
  const counterparty = counterpartyLabel(str(fields, 'counterpartyClass'));
  const decision = str(fields, 'decision');
  const subject =
    action === null
      ? null
      : counterparty === null
        ? action
        : `${action} for a ${counterparty} counterparty`;
  const parts = [subject, decision === null ? null : `policy says ${decision}`].filter(
    (part): part is string => part !== null,
  );
  return parts.join(', ');
}

function observedDetail(fields: Record<string, unknown>): string {
  return str(fields, 'subject') ?? str(fields, 'title') ?? str(fields, 'summary') ?? '';
}

function costDetail(fields: Record<string, unknown>): string {
  const cost = num(fields, 'estimatedCostUsd');
  const input = num(fields, 'inputTokens');
  const output = num(fields, 'outputTokens');
  const parts: string[] = [];
  if (cost !== null) parts.push(`$${cost.toFixed(4)}`);
  if (input !== null) parts.push(`${String(input)} tokens in`);
  if (output !== null) parts.push(`${String(output)} out`);
  return parts.join(', ');
}

function stateChangedDetail(fields: Record<string, unknown>): string {
  const change = str(fields, 'change');
  const reason = str(fields, 'reason');
  if (change === 'mode') {
    const from = str(fields, 'from');
    const to = str(fields, 'to');
    if (to !== null) {
      return from === null
        ? `Mode set to ${humanise(to).toLowerCase()}`
        : `Mode changed from ${humanise(from).toLowerCase()} to ${humanise(to).toLowerCase()}`;
    }
  }
  const paused = fields['paused'];
  if (paused === true) return reason === null ? 'Paused' : `Paused: ${reason}`;
  if (paused === false) return 'Resumed';
  if (change !== null) return reason === null ? humanise(change) : `${humanise(change)}: ${reason}`;
  return '';
}

/** "mailBodies" and "mail_bodies" both become "mail bodies". */
const words = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

function retentionDetail(fields: Record<string, unknown>): string {
  const counts = Object.entries(fields)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, value]) => `${String(value)} ${words(key)}`);
  return counts.join(', ');
}

function alertDetail(fields: Record<string, unknown>): string {
  const severity = str(fields, 'severity');
  const kind = str(fields, 'kind');
  const head = [severity, kind === null ? null : humanise(kind).toLowerCase()]
    .filter((part): part is string => part !== null)
    .join(' ');
  const title = str(fields, 'title');
  if (head === '') return title ?? '';
  return title === null ? head : `${head}: ${title}`;
}

function fallbackDetail(fields: Record<string, unknown>): string {
  for (const key of DESCRIPTIVE_KEYS) {
    const value = str(fields, key);
    if (value !== null) return value;
  }
  const kind = str(fields, 'kind');
  if (kind !== null) return humanise(kind);
  for (const value of Object.values(fields)) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * One line of plain words for a ledger event, read from the payload the
 * writer stored. Each kind has the shape its writer uses; anything else
 * falls back to the first sentence-like field, and to nothing when the
 * payload holds no words at all (a retention run nulls it).
 */
export function ledgerDetail(event: LedgerEventView): string {
  const fields = record(event.payload);
  if (fields === null) return '';
  switch (event.kind) {
    case 'decided':
      return decidedDetail(fields);
    case 'executed':
      return executedDetail(fields, event);
    case 'failed':
      return str(fields, 'error') ?? str(fields, 'message') ?? fallbackDetail(fields);
    case 'proposed':
      return proposedDetail(fields) || fallbackDetail(fields);
    case 'observed':
      return observedDetail(fields) || fallbackDetail(fields);
    case 'cost_recorded':
      return costDetail(fields) || fallbackDetail(fields);
    case 'state_changed':
      return stateChangedDetail(fields) || fallbackDetail(fields);
    case 'retention_applied':
      return retentionDetail(fields) || fallbackDetail(fields);
    case 'alert_raised':
    case 'alert_acked':
      return alertDetail(fields) || fallbackDetail(fields);
    default:
      return fallbackDetail(fields);
  }
}
