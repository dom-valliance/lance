import Link from 'next/link';
import { cn } from 'cn';
import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { PageHeader } from '@/components/page-header';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { ageingEmphasis } from '@/lib/ageing';
import {
  ageingLabel,
  chaseLabel,
  chasePhrase,
  commitmentBadgeFor,
  commitmentDirectionFrom,
  commitmentStatusFilterFrom,
  commitmentStatusSelected,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_STATUS_FILTERS,
  evidenceLine,
  firstName,
  isCommitmentOpenForAction,
  isCommitmentOverdue,
  openCount,
  overdueCount,
  sortCommitments,
  type CommitmentDirection,
  type CommitmentStatus,
  type CommitmentStatusFilter,
  type CommitmentView,
} from '@/lib/commitment-view';
import { type SearchParams } from '@/lib/filters';
import { COMMITMENT_STATUS_LABELS } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { formatDate } from '@/lib/time';
import { COMMITMENT_STATUS_TONES } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';
import { chaseCommitment, dropCommitment, markCommitmentDone } from './actions';
import { CommitmentCard, CommitmentRowPair } from './drop-disclosure';

export const dynamic = 'force-dynamic';

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

const BADGE_LABELS: Record<CommitmentStatus | 'overdue', string> = {
  ...COMMITMENT_STATUS_LABELS,
  overdue: 'Overdue',
};

const COLUMNS = ['Commitment', 'Counterparty', 'Due', 'Chased', 'Provenance', 'Actions'];

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

/** The status badge beside a description, or nothing for a row that needs none. */
function StatusBadge({ commitment }: { commitment: CommitmentView }) {
  const key = commitmentBadgeFor(commitment);
  if (key === null) return null;
  return (
    <Badge tone={COMMITMENT_STATUS_TONES[key]} size="sm">
      {BADGE_LABELS[key]}
    </Badge>
  );
}

/** Every source the commitment was read from, each with the time it was seen. */
function Provenance({ commitment }: { commitment: CommitmentView }) {
  if (commitment.sourceRefs.length === 0) {
    return <span className="text-xs text-muted-foreground">None recorded</span>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {commitment.sourceRefs.map((ref) => (
        <span key={`${ref.system}:${ref.recordId}`} className="flex flex-wrap items-center gap-2">
          <ProvenanceLink
            source={{
              system: ref.system,
              recordId: ref.recordId,
              ...(ref.url === undefined ? {} : { url: ref.url }),
            }}
            seen={false}
          />
          <span className="text-xs text-muted-foreground">{formatInstant(ref.observedAt)}</span>
        </span>
      ))}
    </div>
  );
}

/** The five leading cells of a row, shared by open and closed commitments. */
function RowCells({ commitment, now }: { commitment: CommitmentView; now: Date }) {
  const ageing = ageingLabel(commitment, now);
  return (
    <>
      <Td>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{commitment.description}</span>
          <StatusBadge commitment={commitment} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{evidenceLine(commitment)}</p>
      </Td>
      <Td>
        <p>{commitment.counterparty.name}</p>
        {commitment.counterparty.email === null ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{commitment.counterparty.email}</p>
        )}
      </Td>
      <Td>
        {commitment.dueAt === null ? (
          <span className="text-muted-foreground">No date</span>
        ) : (
          formatDate(commitment.dueAt)
        )}
        <Ageing className="mt-1 flex" label={ageing} emphasis={ageingEmphasis(ageing)} />
      </Td>
      <Td>
        <span className={commitment.chaseCount === 0 ? 'text-muted-foreground' : undefined}>
          {chaseLabel(commitment.chaseCount)}
        </span>
        {commitment.nextChaseAt === null ? null : (
          <p className="mt-1 text-xs text-muted-foreground">
            next {formatInstant(commitment.nextChaseAt)}
          </p>
        )}
      </Td>
      <Td>
        <Provenance commitment={commitment} />
      </Td>
    </>
  );
}

/** Mark done, and Chase on the tab where someone else owes the answer. */
function OpenActions({
  commitment,
  direction,
  size,
}: {
  commitment: CommitmentView;
  direction: CommitmentDirection;
  size: 'sm' | 'lg';
}) {
  return (
    <>
      <ActionForm action={markCommitmentDone} className={cn(size === 'lg' && 'flex-1')}>
        <input type="hidden" name="commitmentId" value={commitment.id} />
        <SubmitButton size={size} pendingLabel="Marking" className={cn(size === 'lg' && 'w-full')}>
          Mark done
        </SubmitButton>
      </ActionForm>
      {direction === 'inbound' ? (
        <ActionForm action={chaseCommitment}>
          <input type="hidden" name="commitmentId" value={commitment.id} />
          <SubmitButton variant="outline" size={size} pendingLabel="Queuing">
            Chase
          </SubmitButton>
        </ActionForm>
      ) : null}
    </>
  );
}

const closedSentence = (commitment: CommitmentView): string =>
  `No actions: this commitment is ${commitment.status}.`;

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
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`). The other tab's open rows are read only for the
  // count beside its label; both reads batch into one request.
  const [page, otherPage] = await Promise.all([
    client.commitments.list.query({
      direction,
      limit: 100,
      ...(statusFilter === undefined ? {} : { status: statusFilter }),
    }),
    client.commitments.list.query({ direction: other, status: 'open', limit: 100 }),
  ]);
  const commitments = sortCommitments(page.items);

  const openHere = openCount(commitments);
  const openThere = openCount(otherPage.items);
  const countFor = (value: CommitmentDirection): number =>
    value === direction ? openHere : openThere;

  const owing = direction === 'inbound' ? 'owed to you' : 'you owe';
  const summary = `Promises found in sent mail and transcripts. ${String(openHere)} open ${owing}, ${String(overdueCount(commitments))} overdue.`;

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
        </TableCard>
      ) : (
        <>
          <TableCard className="hidden lg:block">
            <Table
              caption={`Commitments ${direction === 'outbound' ? 'Dom owes' : 'owed to Dom'}, overdue first`}
            >
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <Th key={column}>{column}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {commitments.map((commitment) =>
                  isCommitmentOpenForAction(commitment) ? (
                    <CommitmentRowPair
                      key={commitment.id}
                      commitmentId={commitment.id}
                      counterpartyFirstName={firstName(commitment.counterparty.name)}
                      dropAction={dropCommitment}
                      {...(isCommitmentOverdue(commitment) ? { accent: 'red' as const } : {})}
                      actions={
                        <OpenActions commitment={commitment} direction={direction} size="sm" />
                      }
                    >
                      <RowCells commitment={commitment} now={now} />
                    </CommitmentRowPair>
                  ) : (
                    <Tr key={commitment.id} muted>
                      <RowCells commitment={commitment} now={now} />
                      <Td>
                        <span className="text-xs text-muted-foreground">
                          {closedSentence(commitment)}
                        </span>
                      </Td>
                    </Tr>
                  ),
                )}
              </tbody>
            </Table>
          </TableCard>

          <ul className="flex flex-col gap-3 lg:hidden">
            {commitments.map((commitment) => {
              const ageing = ageingLabel(commitment, now);
              const chased = chasePhrase(commitment.chaseCount);
              const firstRef = commitment.sourceRefs[0];
              const body = (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{commitment.description}</p>
                    <StatusBadge commitment={commitment} />
                  </div>
                  <p className="text-xs text-muted-foreground">{evidenceLine(commitment)}</p>
                  <p className="text-xs text-muted-foreground">
                    {commitment.counterparty.name} ·{' '}
                    {commitment.dueAt === null ? 'no date' : formatDate(commitment.dueAt)},{' '}
                    <Ageing label={ageing} emphasis={ageingEmphasis(ageing)} />
                    {chased === null ? null : ` · ${chased}`}
                  </p>
                  {firstRef === undefined ? null : (
                    <ProvenanceLink
                      source={{
                        system: firstRef.system,
                        recordId: firstRef.recordId,
                        observedAt: firstRef.observedAt,
                        ...(firstRef.url === undefined ? {} : { url: firstRef.url }),
                      }}
                    />
                  )}
                </>
              );

              return isCommitmentOpenForAction(commitment) ? (
                <CommitmentCard
                  key={commitment.id}
                  commitmentId={commitment.id}
                  counterpartyFirstName={firstName(commitment.counterparty.name)}
                  dropAction={dropCommitment}
                  overdue={isCommitmentOverdue(commitment)}
                  actions={<OpenActions commitment={commitment} direction={direction} size="lg" />}
                >
                  {body}
                </CommitmentCard>
              ) : (
                <li
                  key={commitment.id}
                  className="flex flex-col gap-3 rounded-xl bg-card p-4 text-muted-foreground"
                >
                  {body}
                  <p className="text-xs text-muted-foreground">{closedSentence(commitment)}</p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
