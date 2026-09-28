import Link from 'next/link';
import { cn } from 'cn';
import { TableCard } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
import {
  commitmentStatusFilterFrom,
  commitmentStatusSelected,
  commitmentTabFrom,
  COMMITMENT_STATUS_FILTERS,
  COMMITMENT_TABS,
  sortCommitments,
  type CommitmentStatusFilter,
  type CommitmentTab,
} from '@/lib/commitment-view';
import { type SearchParams } from '@/lib/filters';
import { cursorFrom, pageLinks, pageSummary, PAGE_SIZES, positionFrom } from '@/lib/pagination';
import { apiClient } from '@/lib/trpc';
import { CommitmentsTable } from './commitments-table';

export const dynamic = 'force-dynamic';

/** The filters a page link carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['direction', 'status', 'tab'] as const;

const TAB_LABELS: Record<CommitmentTab, string> = {
  outbound: 'I owe',
  inbound: 'Owed to me',
  triage: 'To confirm',
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

/**
 * A link for this page that keeps every current filter except the one
 * being changed. The triage tab takes no status filter: everything on it
 * is unconfirmed.
 */
function filterHref(
  current: { tab: CommitmentTab; status: CommitmentStatusFilter },
  change: Partial<{ tab: CommitmentTab; status: CommitmentStatusFilter }>,
): string {
  const next = { ...current, ...change };
  if (next.tab === 'triage') return '/commitments?tab=triage';
  const query = new URLSearchParams();
  query.set('direction', next.tab);
  if (next.status !== 'open') query.set('status', next.status);
  return `/commitments?${query.toString()}`;
}

export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const tab = commitmentTabFrom(params);
  const triage = tab === 'triage';
  const direction = triage ? 'inbound' : tab;
  const status = commitmentStatusSelected(params);
  const current = { tab, status };
  const now = new Date();

  const client = await apiClient();
  const statusFilter = triage ? 'unconfirmed' : commitmentStatusFilterFrom(params);
  const cursor = cursorFrom(params);
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`). The header and both tab labels come from the
  // summary, counted in SQL; both reads batch into one request.
  const [page, counts] = await Promise.all([
    client.commitments.list.query({
      direction,
      limit: PAGE_SIZES.commitments,
      ...(statusFilter === undefined ? {} : { status: statusFilter }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    client.commitments.summary.query(),
  ]);
  const commitments = sortCommitments(page.items);

  const number = new Intl.NumberFormat('en-GB');
  const here = counts[direction];
  const owing = direction === 'inbound' ? 'owed to you' : 'you owe';
  const summary = triage
    ? `Promises that may have been made to you or to someone else on the call. ${number.format(counts.unconfirmed)} to confirm. Nothing here is chased until you say it is yours.`
    : `Promises found in sent mail and transcripts. ${number.format(here.open)} open ${owing}, ${number.format(here.overdue)} overdue.`;
  const tabCount = (value: CommitmentTab): number =>
    value === 'triage' ? counts.unconfirmed : counts[value].open;

  const links = pageLinks({
    path: '/commitments',
    params,
    keep: FILTER_PARAMS,
    nextCursor: page.nextCursor,
    shown: commitments.length,
  });
  const position = pageSummary({
    from: positionFrom(params),
    shown: commitments.length,
    total: page.total,
  });
  const footer = <Pagination summary={position} {...links} nextLabel="Show older" />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Commitments" summary={summary} />

      <div className="flex flex-col gap-4">
        <div
          role="tablist"
          aria-label="Direction"
          className="grid grid-cols-3 border-b border-border lg:flex lg:gap-6"
        >
          {COMMITMENT_TABS.map((value) => (
            <Link
              key={value}
              role="tab"
              aria-selected={value === tab}
              href={filterHref(current, { tab: value })}
              className={cn(
                'inline-flex min-h-11 items-center justify-center gap-1 px-1 pb-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/45 lg:justify-start',
                value === tab
                  ? 'font-medium text-foreground shadow-[inset_0_-2px_0_var(--brand)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {TAB_LABELS[value]}
              <span className="text-muted-foreground"> · {number.format(tabCount(value))}</span>
            </Link>
          ))}
        </div>

        {triage ? (
          <p className="text-xs text-muted-foreground">
            Lance could not tell whether these were promised to you. Owed to me moves one to the
            Owed to me tab; Not mine drops it.
          </p>
        ) : (
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
        )}
      </div>

      {commitments.length === 0 ? (
        <TableCard>
          {triage ? (
            <EmptyState>
              Nothing to confirm. A promise lands here when Lance cannot tell whether it was made to
              you.
            </EmptyState>
          ) : (
            <EmptyState>
              No commitments match these filters.{' '}
              <TextLink href={filterHref(current, { status: 'open' })}>Clear them</TextLink> to see
              everything that is open.
            </EmptyState>
          )}
          {footer}
        </TableCard>
      ) : (
        <CommitmentsTable
          commitments={commitments}
          direction={direction}
          triage={triage}
          now={now}
          footer={footer}
        />
      )}
    </div>
  );
}
