/**
 * View model for the Commitments page (spec 12: "Two tabs: I owe, owed to
 * me. Ageing, chase button, mark done, drop with reason."). The shape below
 * mirrors the `commitments.list`/`markDone`/`drop`/`chase` contract another
 * engineer is adding to `apps/api` at the same time; the api router is the
 * source of truth once it lands, and this file is the one place a drift
 * would need fixing.
 *
 * Kept local, rather than imported from `@lance/shared`, because the web
 * app cannot depend on api or worker-side packages (see
 * `apps/web/src/lib/proposal-view.ts` for the same pattern with
 * `ProposalStatus`).
 */

import { oneOf, selected, type SearchParams } from '@/lib/filters';
import type { ApiClient } from '@/lib/trpc';

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
  system: string;
  recordId: string;
  hash: string;
  observedAt: string;
  url?: string;
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
export function ageingLabel(view: CommitmentView, now: Date = new Date()): string {
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
export function commitmentSort(a: CommitmentView, b: CommitmentView): number {
  const aOverdue = a.overdueDays ?? 0;
  const bOverdue = b.overdueDays ?? 0;
  if (aOverdue !== bOverdue) return bOverdue - aOverdue;

  const aDue = a.dueAt === null ? Number.POSITIVE_INFINITY : new Date(a.dueAt).getTime();
  const bDue = b.dueAt === null ? Number.POSITIVE_INFINITY : new Date(b.dueAt).getTime();
  if (aDue !== bDue) return aDue - bDue;

  return b.ageDays - a.ageDays;
}

/** Sorts a copy of `views`; the source array is left untouched. */
export function sortCommitments(views: readonly CommitmentView[]): CommitmentView[] {
  return [...views].sort(commitmentSort);
}

/** Whether the row still accepts "mark done" or "drop". */
export function isCommitmentOpenForAction(view: CommitmentView): boolean {
  return view.status !== 'done' && view.status !== 'dropped';
}

/**
 * The `commitments` router as another engineer is adding it to `apps/api`
 * at the same time as this page (see the tRPC contract in the task
 * brief). `AppRouter` (imported in `@/lib/trpc`) does not carry
 * `commitments` yet, so this narrow contract stands in for it; the api
 * router is the source of truth once it lands, and this interface and the
 * cast in `commitmentsRouter` are deleted then in favour of calling
 * `client.commitments` directly.
 */
export interface CommitmentsRouterContract {
  list: {
    query(input: {
      direction?: CommitmentDirection;
      status?: CommitmentStatus;
      limit?: number;
      cursor?: string;
    }): Promise<{ items: CommitmentView[]; nextCursor: string | null }>;
  };
  markDone: { mutate(input: { id: string }): Promise<CommitmentView> };
  drop: { mutate(input: { id: string; reason: string }): Promise<CommitmentView> };
  chase: { mutate(input: { id: string }): Promise<{ enqueued: true; jobId: string }> };
}

/** The one place the stand-in cast above lives. */
export function commitmentsRouter(client: ApiClient): CommitmentsRouterContract {
  return (client as unknown as { commitments: CommitmentsRouterContract }).commitments;
}
