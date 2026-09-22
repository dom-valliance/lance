import Link from 'next/link';
import { cn } from 'cn';
import { Table, TableCard, TableFooterBar, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import {
  ACTION_CLASSES,
  PROPOSAL_STATUSES,
  proposalFilterFrom,
  selected,
  SYSTEMS,
  type ProposalStatus,
  type SearchParams,
} from '@/lib/filters';
import {
  ACTION_CLASS_LABELS,
  COUNTERPARTY_LABELS,
  PROPOSAL_STATUS_LABELS,
  SYSTEM_LABELS,
} from '@/lib/humanise';
import {
  expiryCell,
  previewDetail,
  proposalFilterLabels,
  queueSummary,
  type ExpiryCell,
} from '@/lib/proposal-view';
import { PROPOSAL_STATUS_TONES, SYSTEM_TONES } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

/** One page of the queue; "Show older" asks for the next page from the last id. */
const PAGE_SIZE = 50;
/** Enough pending proposals to count and to find the oldest expiry (the api caps at 200). */
const PENDING_LIMIT = 200;

const COLUMNS = ['Preview', 'Action class', 'Counterparty', 'System', 'Status', 'Expires'];

type OpenAccent = 'brand' | 'pink';

/** The accent bar that marks a row still waiting on Dom. */
const ROW_ACCENT: Partial<Record<ProposalStatus, OpenAccent>> = { pending: 'brand', held: 'pink' };

const CARD_ACCENT: Record<OpenAccent, string> = {
  brand: 'shadow-[inset_2px_0_0_var(--brand)]',
  pink: 'shadow-[inset_2px_0_0_var(--sem-pink-fg)]',
};

const isOpen = (status: ProposalStatus): boolean => status === 'pending' || status === 'held';

/** The filters the queue carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['status', 'actionClass', 'system'] as const;

/** The same filters plus a cursor: the link that asks for the page after this one. */
function olderHref(params: SearchParams, cursor: string): string {
  const query = new URLSearchParams();
  for (const name of FILTER_PARAMS) {
    const value = selected(params, name);
    if (value !== '') query.set(name, value);
  }
  query.set('cursor', cursor);
  return `/proposals?${query.toString()}`;
}

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

function Expiry({ cell }: { cell: ExpiryCell }) {
  return (
    <>
      <div className="font-medium">{cell.lead}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{cell.detail}</div>
    </>
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

  // The queue itself and the pending count are one round trip: the header
  // sentence counts everything waiting, not just the filtered page.
  const [proposals, pending] = await Promise.all([
    client.proposals.list.query({ ...filter, limit: PAGE_SIZE }),
    client.proposals.list.query({ status: 'pending', limit: PENDING_LIMIT }),
  ]);

  const names = proposalFilterLabels(filter);
  const shown = `${String(proposals.length)} shown${names.length === 0 ? '' : `, filtered by ${names.join(', ')}`}`;
  const last = proposals.at(-1);
  const older =
    proposals.length === PAGE_SIZE && last !== undefined ? olderHref(params, last.id) : null;

  const rows = proposals.map((proposal) => ({
    proposal,
    open: isOpen(proposal.status),
    detail: previewDetail(proposal),
    expiry: expiryCell(proposal, now),
    accent: ROW_ACCENT[proposal.status] ?? null,
  }));

  const empty = (
    <EmptyState>
      No proposals match these filters. <TextLink href="/proposals">Clear them</TextLink> to see the
      whole queue.
    </EmptyState>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Proposals"
        summary={queueSummary(pending, now)}
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

      <TableCard className="hidden lg:block">
        <Table caption="Proposals, newest first">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <Th key={column}>{column}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ proposal, open, detail, expiry, accent }) => (
              <Tr
                key={proposal.id}
                liveId={proposal.id}
                muted={!open}
                {...(accent === null ? {} : { accent })}
              >
                <Td>
                  <TextLink
                    href={`/proposals/${proposal.id}`}
                    tone="foreground"
                    className={cn('font-medium', !open && 'text-[oklch(0.85_0_0)]')}
                  >
                    {proposal.preview}
                  </TextLink>
                  {detail === null ? null : (
                    <div className="mt-0.5 max-w-[46ch] truncate text-xs text-muted-foreground">
                      {detail}
                    </div>
                  )}
                </Td>
                <Td>{ACTION_CLASS_LABELS[proposal.actionClass]}</Td>
                <Td>{COUNTERPARTY_LABELS[proposal.counterpartyClass]}</Td>
                <Td>
                  <Badge
                    tone={SYSTEM_TONES[proposal.targetSystem]}
                    className={open ? undefined : 'opacity-70'}
                  >
                    {SYSTEM_LABELS[proposal.targetSystem]}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>
                    {PROPOSAL_STATUS_LABELS[proposal.status]}
                  </Badge>
                </Td>
                <Td>
                  <Expiry cell={expiry} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {rows.length === 0 ? empty : null}
        <TableFooterBar>
          <span>{shown}</span>
          {older === null ? null : <TextLink href={older}>Show older</TextLink>}
        </TableFooterBar>
      </TableCard>

      <div className="flex flex-col gap-3 lg:hidden">
        <p className="text-xs text-muted-foreground">{shown}</p>
        {rows.length === 0 ? <div className="rounded-xl bg-card">{empty}</div> : null}
        {rows.map(({ proposal, open, expiry, accent }) => (
          <Link
            key={proposal.id}
            href={`/proposals/${proposal.id}`}
            data-live-id={proposal.id}
            className={cn(
              'flex flex-col gap-2 rounded-xl bg-card p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/45',
              accent === null ? null : CARD_ACCENT[accent],
            )}
          >
            <span className="flex items-start justify-between gap-3">
              <span className={cn('font-medium', !open && 'text-[oklch(0.85_0_0)]')}>
                {proposal.preview}
              </span>
              <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>
                {PROPOSAL_STATUS_LABELS[proposal.status]}
              </Badge>
            </span>
            <span className="text-xs text-muted-foreground">
              {ACTION_CLASS_LABELS[proposal.actionClass]} ·{' '}
              {COUNTERPARTY_LABELS[proposal.counterpartyClass]} ·{' '}
              {SYSTEM_LABELS[proposal.targetSystem]}
            </span>
            <span className="text-xs text-muted-foreground">
              {expiry.lead} · {expiry.detail}
            </span>
          </Link>
        ))}
        {older === null ? null : (
          <TextLink href={older} className="min-h-11 py-3 text-sm">
            Show older
          </TextLink>
        )}
      </div>
    </div>
  );
}
