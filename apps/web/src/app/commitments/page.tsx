import Link from 'next/link';
import { cn } from 'cn';
import { TableCard } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
import {
  commitmentDirectionFrom,
  commitmentStatusFilterFrom,
  commitmentStatusSelected,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_STATUS_FILTERS,
  openCount,
  overdueCount,
  sortCommitments,
  type CommitmentDirection,
  type CommitmentStatusFilter,
} from '@/lib/commitment-view';
import { type SearchParams } from '@/lib/filters';
import { cursorFrom, pageLinks, PAGE_SIZES, shownLabel } from '@/lib/pagination';
import { apiClient } from '@/lib/trpc';
import { CommitmentsTable } from './commitments-table';

export const dynamic = 'force-dynamic';

/** Enough open rows on the other tab to count beside its label. */
const COUNT_LIMIT = 100;

/** The filters a page link carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['direction', 'status'] as const;

const DIRECTION_LABELS: Record<CommitmentDirection, string> = {
  outbound: 'I owe',
  inbound: 'Owed to me',
};

const STATUS_LABELS: Record<CommitmentStatusFilter, string> = {
  open: 'Open',
  chased: 'Chased',
  done: 'Done',
  dropped: 'Dropped',
  all: 'All',
};

/** Pills scroll sideways at 360 rather than wrapping on to a second line. */
const PILL_ROW = 'flex-nowrap overflow-x-auto [&>span]:shrink-0 [&>div]:flex-nowrap';

/** A link for this page that keeps every current filter except the one being changed. */
function filterHref(
  current: { direction: CommitmentDirection; status: CommitmentStatusFilter },
  change: Partial<{ direction: CommitmentDirection; status: CommitmentStatusFilter }>,
): string {
  const next = { ...current, ...change };
  const query = new URLSearchParams();
  query.set('direction', next.direction);
  if (next.status !== 'open') query.set('status', next.status);
  return `/commitments?${query.toString()}`;
}

export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const direction = commitmentDirectionFrom(params);
  const status = commitmentStatusSelected(params);
  const current = { direction, status };
  const now = new Date();
  const other: CommitmentDirection = direction === 'inbound' ? 'outbound' : 'inbound';

  const client = await apiClient();
  const statusFilter = commitmentStatusFilterFrom(params);
  const cursor = cursorFrom(params);
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`). The other tab's open rows are read only for the
  // count beside its label; both reads batch into one request.
  const [page, otherPage] = await Promise.all([
    client.commitments.list.query({
      direction,
      limit: PAGE_SIZES.commitments,
      ...(statusFilter === undefined ? {} : { status: statusFilter }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    client.commitments.list.query({ direction: other, status: 'open', limit: COUNT_LIMIT }),
  ]);
  const commitments = sortCommitments(page.items);

  const openHere = openCount(commitments);
  const openThere = openCount(otherPage.items);
  const countFor = (value: CommitmentDirection): number =>
    value === direction ? openHere : openThere;

  const owing = direction === 'inbound' ? 'owed to you' : 'you owe';
  const summary = `Promises found in sent mail and transcripts. ${String(openHere)} open ${owing}, ${String(overdueCount(commitments))} overdue.`;

  const links = pageLinks({
    path: '/commitments',
    params,
    keep: FILTER_PARAMS,
    nextCursor: page.nextCursor,
  });
  const footer = (
    <Pagination summary={shownLabel(commitments.length)} {...links} nextLabel="Show older" />
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Commitments" summary={summary} />

      <div className="flex flex-col gap-4">
        <div
          role="tablist"
          aria-label="Direction"
          className="grid grid-cols-2 border-b border-border lg:flex lg:gap-6"
        >
          {COMMITMENT_DIRECTIONS.map((value) => (
            <Link
              key={value}
              role="tab"
              aria-selected={value === direction}
              href={filterHref(current, { direction: value })}
              className={cn(
                'inline-flex min-h-11 items-center justify-center gap-1 px-1 pb-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/45 lg:justify-start',
                value === direction
                  ? 'font-medium text-foreground shadow-[inset_0_-2px_0_var(--brand)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {DIRECTION_LABELS[value]}
              <span className="text-muted-foreground"> · {String(countFor(value))}</span>
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterLinks
            label="Status"
            options={COMMITMENT_STATUS_FILTERS.map((value) => ({
              label: STATUS_LABELS[value],
              href: filterHref(current, { status: value }),
              active: status === value,
            }))}
            className={PILL_ROW}
          />
          <p className="text-xs text-muted-foreground">
            Sorted overdue first, then soonest due, then oldest
          </p>
        </div>
      </div>

      {commitments.length === 0 ? (
        <TableCard>
          <EmptyState>
            No commitments match these filters.{' '}
            <TextLink href={filterHref(current, { status: 'open' })}>Clear them</TextLink> to see
            everything that is open.
          </EmptyState>
          {footer}
        </TableCard>
      ) : (
        <CommitmentsTable
          commitments={commitments}
          direction={direction}
          now={now}
          footer={footer}
        />
      )}
    </div>
  );
}
