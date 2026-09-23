import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import {
  ACTION_CLASSES,
  PROPOSAL_STATUSES,
  proposalFilterFrom,
  selected,
  SYSTEMS,
  type SearchParams,
} from '@/lib/filters';
import { ACTION_CLASS_LABELS, PROPOSAL_STATUS_LABELS, SYSTEM_LABELS } from '@/lib/humanise';
import { pageLinks, pageSummary, PAGE_SIZES, positionFrom } from '@/lib/pagination';
import { proposalFilterLabels, queueSummary } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';
import { ProposalsTable } from './proposals-table';

export const dynamic = 'force-dynamic';

/** The filters the queue carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['status', 'actionClass', 'system'] as const;

function FilterForm({ params }: { params: SearchParams }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <Field label="Status" className="w-full sm:w-40">
        <Select name="status" defaultValue={selected(params, 'status')}>
          <option value="">Any</option>
          {PROPOSAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROPOSAL_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Action class" className="w-full sm:w-48">
        <Select name="actionClass" defaultValue={selected(params, 'actionClass')}>
          <option value="">Any</option>
          {ACTION_CLASSES.map((actionClass) => (
            <option key={actionClass} value={actionClass}>
              {ACTION_CLASS_LABELS[actionClass]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="System" className="w-full sm:w-44">
        <Select name="system" defaultValue={selected(params, 'system')}>
          <option value="">Any</option>
          {SYSTEMS.map((system) => (
            <option key={system} value={system}>
              {SYSTEM_LABELS[system]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit">Apply filters</Button>
      <Button asChild variant="ghost">
        <Link href="/proposals">Clear</Link>
      </Button>
    </form>
  );
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const now = new Date();
  const filter = proposalFilterFrom(params);
  const client = await apiClient();

  // The queue itself and the pending summary are one round trip: the header
  // sentence counts everything waiting, not just the filtered page.
  const [page, pending] = await Promise.all([
    client.proposals.list.query({ ...filter, limit: PAGE_SIZES.proposals }),
    client.proposals.summary.query(),
  ]);

  const names = proposalFilterLabels(filter);
  const shown = pageSummary({
    from: positionFrom(params),
    shown: page.items.length,
    total: page.total,
    filterNames: names,
  });
  const links = pageLinks({
    path: '/proposals',
    params,
    keep: FILTER_PARAMS,
    nextCursor: page.nextCursor,
    shown: page.items.length,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Proposals"
        summary={queueSummary(pending.pending, pending.oldestExpiresAt, now)}
        actions={<LiveRefresh streamUrl="/api/events" watch="proposal" indicator />}
      />

      <div className="hidden items-end justify-between gap-6 rounded-xl bg-card px-6 py-4 lg:flex">
        <FilterForm params={params} />
        <p className="pb-2 text-xs whitespace-nowrap text-muted-foreground">{shown}</p>
      </div>

      <details className="rounded-xl bg-card px-4 py-3 lg:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Filters{names.length === 0 ? '' : `: ${names.join(', ')}`}
        </summary>
        <div className="pt-3">
          <FilterForm params={params} />
        </div>
      </details>

      <ProposalsTable
        proposals={page.items}
        now={now}
        empty={
          <EmptyState>
            No proposals match these filters. <TextLink href="/proposals">Clear them</TextLink> to
            see the whole queue.
          </EmptyState>
        }
        footer={<Pagination summary={shown} {...links} nextLabel="Show older" />}
      />
    </div>
  );
}
