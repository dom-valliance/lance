/**
 * View model for the Commitments page (spec 12: "Two tabs: I owe, owed to
 * me. Ageing, chase button, mark done, drop with reason."). The page reads
 * `client.commitments`, whose types are the source of truth; `CommitmentView`
 * below is the local mirror the pure helpers and their tests take.
 *
 * Kept local, rather than imported from `@lance/shared`, because the web
 * app cannot depend on api or worker-side packages (see
 * `apps/web/src/lib/proposal-view.ts` for the same pattern with
 * `ProposalStatus`).
 */

import { oneOf, selected, type SearchParams, type SourceSystem } from '@/lib/filters';

export const COMMITMENT_DIRECTIONS = ['outbound', 'inbound'] as const;
export type CommitmentDirection = (typeof COMMITMENT_DIRECTIONS)[number];

export const COMMITMENT_STATUSES = ['open', 'chased', 'done', 'dropped'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/** The status filter options the page offers, in display order. */
export const COMMITMENT_STATUS_FILTERS = [...COMMITMENT_STATUSES, 'all'] as const;
export type CommitmentStatusFilter = (typeof COMMITMENT_STATUS_FILTERS)[number];

export interface CommitmentPerson {
  id: string;
  name: string;
  email: string | null;
}

export interface CommitmentSourceRef {
  system: SourceSystem;
  recordId: string;
  hash: string;
  observedAt: string;
  url?: string | undefined;
}

export interface CommitmentView {
  id: string;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  description: string;
  evidenceQuote: string;
  dueAt: string | null;
  dueConfidence: number | null;
  ageDays: number;
  overdueDays: number | null;
  chaseCount: number;
  nextChaseAt: string | null;
  owner: CommitmentPerson;
  counterparty: CommitmentPerson;
  sourceRefs: CommitmentSourceRef[];
  createdAt: string;
  updatedAt: string;
}

/** The tab the page shows: `?direction=inbound`, otherwise the default. */
export function commitmentDirectionFrom(params: SearchParams): CommitmentDirection {
  return oneOf(COMMITMENT_DIRECTIONS, params['direction']) ?? 'outbound';
}

/** The status filter selected in the query string, `open` when absent. */
export function commitmentStatusSelected(params: SearchParams): CommitmentStatusFilter {
  const raw = selected(params, 'status');
  return raw === '' ? 'open' : (oneOf(COMMITMENT_STATUS_FILTERS, raw) ?? 'open');
}

/** The status the api should filter by; `undefined` means "all". */
export function commitmentStatusFilterFrom(params: SearchParams): CommitmentStatus | undefined {
  const selectedFilter = commitmentStatusSelected(params);
  return selectedFilter === 'all' ? undefined : selectedFilter;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const pluralDays = (value: number): string => `${value} day${value === 1 ? '' : 's'}`;

const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * A plain-words ageing label for a commitment row, in the "due in 3 days",
 * "overdue by 2 days", "no date", "done 12 days ago" style the spec asks
 * for. `overdueDays` and `dueAt` come from the api's own clock; `now` is
 * only for computing how many days remain on a commitment that is not yet
 * overdue, and defaults to the real time so callers do not normally pass it.
 */
export function ageingLabel(
  view: Pick<CommitmentView, 'status' | 'updatedAt' | 'overdueDays' | 'dueAt'>,
  now: Date = new Date(),
): string {
  if (view.status === 'done') {
    const since = daysBetween(new Date(view.updatedAt), now);
    if (since <= 0) return 'done today';
    if (since === 1) return 'done yesterday';
    return `done ${pluralDays(since)} ago`;
  }

  if (view.status === 'dropped') {
    const since = daysBetween(new Date(view.updatedAt), now);
    if (since <= 0) return 'dropped today';
    if (since === 1) return 'dropped yesterday';
    return `dropped ${pluralDays(since)} ago`;
  }

  if (view.overdueDays !== null && view.overdueDays > 0) {
    return `overdue by ${pluralDays(view.overdueDays)}`;
  }

  if (view.dueAt === null) return 'no date';

  const until = daysBetween(now, new Date(view.dueAt));
  if (until <= 0) return 'due today';
  return `due in ${pluralDays(until)}`;
}

/**
 * Sort order for the commitments table: overdue first (most overdue
 * first), then soonest due date, then oldest commitment first as the final
 * tie-break. A commitment with no due date sorts after every dated one.
 */
export type SortableCommitment = Pick<CommitmentView, 'overdueDays' | 'dueAt' | 'ageDays'>;

export function commitmentSort(a: SortableCommitment, b: SortableCommitment): number {
  const aOverdue = a.overdueDays ?? 0;
  const bOverdue = b.overdueDays ?? 0;
  if (aOverdue !== bOverdue) return bOverdue - aOverdue;

  const aDue = a.dueAt === null ? Number.POSITIVE_INFINITY : new Date(a.dueAt).getTime();
  const bDue = b.dueAt === null ? Number.POSITIVE_INFINITY : new Date(b.dueAt).getTime();
  if (aDue !== bDue) return aDue - bDue;

  return b.ageDays - a.ageDays;
}

/** Sorts a copy of `views`; the source array is left untouched. */
export function sortCommitments<T extends SortableCommitment>(views: readonly T[]): T[] {
  return [...views].sort(commitmentSort);
}

/** Whether the row still accepts "mark done" or "drop". */
export function isCommitmentOpenForAction(view: Pick<CommitmentView, 'status'>): boolean {
  return view.status !== 'done' && view.status !== 'dropped';
}

/** Whether the row is past its due date and still running. */
export function isCommitmentOverdue(view: Pick<CommitmentView, 'overdueDays'>): boolean {
  return view.overdueDays !== null && view.overdueDays > 0;
}

/** How many rows of a list still accept an action. */
export function openCount(views: readonly Pick<CommitmentView, 'status'>[]): number {
  return views.filter((view) => isCommitmentOpenForAction(view)).length;
}

/** How many rows of a list are past their due date. */
export function overdueCount(views: readonly Pick<CommitmentView, 'overdueDays'>[]): number {
  return views.filter((view) => isCommitmentOverdue(view)).length;
}

/**
 * The badge that sits beside a row's description, as a key into
 * `COMMITMENT_STATUS_TONES` and the label table. Overdue beats the stored
 * status, since it is what the reader has to act on; an open row that is
 * not overdue carries no badge, and neither does a dropped one, whose cell
 * already says there is nothing left to do.
 */
export function commitmentBadgeFor(
  view: Pick<CommitmentView, 'status' | 'overdueDays'>,
): CommitmentStatus | 'overdue' | null {
  if (isCommitmentOverdue(view)) return 'overdue';
  if (view.status === 'chased') return 'chased';
  if (view.status === 'done') return 'done';
  return null;
}

/** The Chased column's first line: "not yet", "1 time", "4 times". */
export function chaseLabel(count: number): string {
  if (count <= 0) return 'not yet';
  return count === 1 ? '1 time' : `${String(count)} times`;
}

/** The same count in the phone card's sentence: "chased once", "chased twice". */
export function chasePhrase(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return 'chased once';
  if (count === 2) return 'chased twice';
  return `chased ${String(count)} times`;
}

/**
 * The evidence line beneath a description: the verbatim quote in straight
 * double quotes, and on the "I owe" tab who it was said to, since the
 * counterparty column reads as the person waiting either way.
 */
export function evidenceLine(
  view: Pick<CommitmentView, 'direction' | 'evidenceQuote' | 'counterparty'>,
): string {
  const quoted = `"${view.evidenceQuote}"`;
  return view.direction === 'outbound' ? `${quoted} to ${view.counterparty.name}` : quoted;
}

/** The name the drop form uses in "Nothing is sent to Marcus." */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
