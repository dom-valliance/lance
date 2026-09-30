import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TableCard } from '@/components/data-table';
import { TextLink } from '@/components/text-link';
import { buildBoard } from '@/lib/commitment-board';
import { commitmentDirectionFrom, sortCommitments } from '@/lib/commitment-view';
import { selected, type SearchParams } from '@/lib/filters';
import { cursorFrom, pageLinks, pageSummary, PAGE_SIZES, positionFrom } from '@/lib/pagination';
import { apiClient } from '@/lib/trpc';
import { CommitmentBoard } from './board';
import { TriageTable } from './triage-table';

export const dynamic = 'force-dynamic';

const TRIAGE_HREF = '/commitments?tab=triage';

const number = new Intl.NumberFormat('en-GB');

/**
 * The Commitments page (design 7.5): the swimlane board of everything
 * running and everything closed in the last fortnight. Commitments that
 * may not be owed to the principal (ADR 0037) wait on a triage list of
 * their own, `?tab=triage`, which the strip above the board points to.
 */
export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return selected(params, 'tab') === 'triage' ? (
    <TriageView params={params} />
  ) : (
    <BoardView params={params} />
  );
}

async function BoardView({ params }: { params: SearchParams }) {
  const client = await apiClient();
  const [board, counts] = await Promise.all([
    client.commitments.board.query(),
    client.commitments.summary.query(),
  ]);
  const { totals } = buildBoard(board.items);
  const summary = `Promises found in sent mail and transcripts. ${number.format(totals.owed)} open owed to you, ${number.format(totals.owe)} you owe, ${number.format(totals.overdue)} overdue.`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Commitments"
        summary={summary}
        actions={
          <span className="hidden text-xs text-muted-foreground lg:inline">
            Each column sorted overdue first, then soonest due. Done and Dropped show the last{' '}
            {board.closedDays} days.
          </span>
        }
      />

      {counts.unconfirmed === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-4 py-2.5 text-[13px]">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <span className="flex-1">
            {number.format(counts.unconfirmed)}{' '}
            {counts.unconfirmed === 1 ? 'promise might be' : 'promises might be'} owed to you or to
            someone else on the call. Nothing chases them until you say.
          </span>
          <TextLink href={TRIAGE_HREF}>Confirm them</TextLink>
        </div>
      )}

      {board.truncated ? (
        <p className="m-0 text-xs text-muted-foreground">
          The board shows the newest {number.format(board.items.length)} commitments. Older ones
          open from the Ledger.
        </p>
      ) : null}

      {board.items.length === 0 ? (
        <div className="rounded-xl bg-card px-6 py-8 text-pretty text-muted-foreground">
          No commitments yet. Lance picks them up from sent mail and transcripts as they arrive.
        </div>
      ) : (
        <CommitmentBoard
          items={board.items}
          now={new Date().toISOString()}
          initialLane={commitmentDirectionFrom(params)}
        />
      )}
    </div>
  );
}

async function TriageView({ params }: { params: SearchParams }) {
  const client = await apiClient();
  const cursor = cursorFrom(params);
  const [page, counts] = await Promise.all([
    client.commitments.list.query({
      status: 'unconfirmed',
      limit: PAGE_SIZES.commitments,
      ...(cursor === undefined ? {} : { cursor }),
    }),
    client.commitments.summary.query(),
  ]);
  const commitments = sortCommitments(page.items);
  const links = pageLinks({
    path: '/commitments',
    params,
    keep: ['tab'],
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
    <div className="flex flex-col gap-5">
      <PageHeader
        back={{ href: '/commitments', label: 'Back to the board' }}
        title="To confirm"
        summary={`Promises that may have been made to you or to someone else on the call. ${number.format(counts.unconfirmed)} to confirm. Nothing here is chased until you say it is yours.`}
      />
      <p className="m-0 text-xs text-muted-foreground">
        Owed to me puts one on the board; Not mine drops it with that reason.
      </p>
      {commitments.length === 0 ? (
        <TableCard>
          <EmptyState>
            Nothing to confirm. A promise lands here when Lance cannot tell whether it was made to
            you.
          </EmptyState>
          {footer}
        </TableCard>
      ) : (
        <TriageTable commitments={commitments} now={new Date()} footer={footer} />
      )}
    </div>
  );
}
