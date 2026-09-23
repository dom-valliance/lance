/**
 * Search params in, api filters out. Pure functions so the pages stay
 * declarative and the parsing is tested on its own.
 *
 * The option lists mirror the enums `apps/api` validates with Zod. A value
 * that drifts from the api's union is a compile error where a page passes
 * the filter to the tRPC client, and an unrecognised search param is
 * dropped here rather than sent on.
 */

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'edited',
  'rejected',
  'expired',
  'held',
  'executing',
  'executed',
  'failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const ACTION_CLASSES = [
  'read',
  'classify',
  'draft_email',
  'apply_category',
  'move_mail',
  'create_task',
  'update_task',
  'complete_task',
  'create_tag',
  'apply_tag',
  'create_calendar_hold',
  'post_slack',
  'send_email',
  'delete',
  'rule_change',
  'promote_to_shared',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const SYSTEMS = ['graph', 'jamie', 'notion', 'slack', 'lance'] as const;
export type TargetSystem = (typeof SYSTEMS)[number];

export const COUNTERPARTY_CLASSES = [
  'self',
  'internal',
  'client',
  'prospect',
  'partner',
  'vendor',
  'unknown',
] as const;
export type CounterpartyClass = (typeof COUNTERPARTY_CLASSES)[number];

export const LEDGER_KINDS = [
  'observed',
  'resolved',
  'proposed',
  'decided',
  'executed',
  'failed',
  'alert_raised',
  'alert_acked',
  'rule_changed',
  'state_changed',
  'retention_applied',
  'cost_recorded',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const SOURCE_SYSTEMS = ['graph', 'jamie', 'notion', 'slack', 'lance', 'webhook'] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

/** Next gives a repeated search param as an array; the first value wins. */
export type SearchParams = Record<string, string | string[] | undefined>;

export const oneOf = <T extends string>(
  allowed: readonly T[],
  value: string | string[] | undefined,
): T | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === '') return undefined;
  return (allowed as readonly string[]).includes(first) ? (first as T) : undefined;
};

const text = (value: string | string[] | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim() === '' ? undefined : first.trim();
};

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date the filter form supplies as `YYYY-MM-DD`, widened to the instant
 * the api wants. `from` starts the day, `to` ends it, both in UTC, so a
 * one-day range covers that whole day.
 */
const instant = (
  value: string | string[] | undefined,
  edge: 'start' | 'end',
): string | undefined => {
  const day = text(value);
  if (day === undefined || !CALENDAR_DAY.test(day)) return undefined;
  return edge === 'start' ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;
};

/**
 * A ULID is 26 Crockford base32 characters, which is what the api's
 * `UlidSchema` accepts. Anything else in the `cursor` param is a typed or
 * tampered URL, so it is dropped here and the first page is served rather
 * than sending the api a value it would reject.
 */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const isUlid = (value: string): boolean => ULID.test(value);

const ulid = (value: string | string[] | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && isUlid(first) ? first : undefined;
};

export interface ProposalFilter {
  status?: ProposalStatus;
  actionClass?: ActionClass;
  targetSystem?: TargetSystem;
  /** The id of the last proposal on the previous page; ULIDs sort in creation order. */
  cursor?: string;
}

export const proposalFilterFrom = (params: SearchParams): ProposalFilter => {
  const filter: ProposalFilter = {};
  const status = oneOf(PROPOSAL_STATUSES, params['status']);
  const actionClass = oneOf(ACTION_CLASSES, params['actionClass']);
  const targetSystem = oneOf(SYSTEMS, params['system']);
  const cursor = ulid(params['cursor']);
  if (status !== undefined) filter.status = status;
  if (actionClass !== undefined) filter.actionClass = actionClass;
  if (targetSystem !== undefined) filter.targetSystem = targetSystem;
  if (cursor !== undefined) filter.cursor = cursor;
  return filter;
};

export interface LedgerFilter {
  kind?: LedgerKind;
  actor?: string;
  sourceSystem?: SourceSystem;
  from?: string;
  to?: string;
}

export const ledgerFilterFrom = (params: SearchParams): LedgerFilter => {
  const filter: LedgerFilter = {};
  const kind = oneOf(LEDGER_KINDS, params['kind']);
  const actor = text(params['actor']);
  const sourceSystem = oneOf(SOURCE_SYSTEMS, params['sourceSystem']);
  const from = instant(params['from'], 'start');
  const to = instant(params['to'], 'end');
  if (kind !== undefined) filter.kind = kind;
  if (actor !== undefined) filter.actor = actor;
  if (sourceSystem !== undefined) filter.sourceSystem = sourceSystem;
  if (from !== undefined) filter.from = from;
  if (to !== undefined) filter.to = to;
  return filter;
};

/** The value a select should show, so a filtered page renders its own state. */
export const selected = (params: SearchParams, name: string): string => {
  const value = params[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? '';
};
