import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from 'cn';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import type { ActionClass, CounterpartyClass, ProposalStatus, TargetSystem } from '@/lib/filters';
import {
  ACTION_CLASS_LABELS,
  COUNTERPARTY_LABELS,
  PROPOSAL_STATUS_LABELS,
  SYSTEM_LABELS,
} from '@/lib/humanise';
import { expiryCell, previewDetail, type ExpiryCell } from '@/lib/proposal-view';
import { PROPOSAL_STATUS_TONES, SYSTEM_TONES } from '@/lib/tones';

/**
 * The proposals queue, one page of it: the table on a desktop and the same
 * rows as cards on a phone. The page fetches and filters; this renders.
 */

/** The six columns, in order; `loading.tsx` keeps its own copy of the names. */
const PROPOSAL_COLUMNS = ['Preview', 'Action class', 'Counterparty', 'System', 'Status', 'Expires'];

/** Structurally what `proposals.list` returns, down to the columns shown here. */
export interface ProposalRow {
  id: string;
  preview: string;
  status: ProposalStatus;
  actionClass: ActionClass;
  counterpartyClass: CounterpartyClass;
  targetSystem: TargetSystem;
  payload: Record<string, unknown>;
  expiresAt: Date | string;
  decidedAt: Date | string | null;
  policyDecision: string;
}

type OpenAccent = 'brand' | 'pink';

/** The accent bar that marks a row still waiting on Dom. */
const ROW_ACCENT: Partial<Record<ProposalStatus, OpenAccent>> = { pending: 'brand', held: 'pink' };

const CARD_ACCENT: Record<OpenAccent, string> = {
  brand: 'shadow-[inset_2px_0_0_var(--brand)]',
  pink: 'shadow-[inset_2px_0_0_var(--sem-pink-fg)]',
};

const isOpen = (status: ProposalStatus): boolean => status === 'pending' || status === 'held';

function Expiry({ cell }: { cell: ExpiryCell }) {
  return (
    <>
      <div className="font-medium">{cell.lead}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{cell.detail}</div>
    </>
  );
}

export function ProposalsTable({
  proposals,
  now,
  empty,
  footer,
}: {
  proposals: readonly ProposalRow[];
  now: Date;
  /** What stands in for the rows when the filters match nothing. */
  empty: ReactNode;
  /** The paging footer, rendered under the table and under the cards. */
  footer: ReactNode;
}) {
  const rows = proposals.map((proposal) => ({
    proposal,
    open: isOpen(proposal.status),
    detail: previewDetail(proposal),
    expiry: expiryCell(proposal, now),
    accent: ROW_ACCENT[proposal.status] ?? null,
  }));

  return (
    <>
      <TableCard className="hidden lg:block">
        <Table caption="Proposals, newest first">
          <thead>
            <tr>
              {PROPOSAL_COLUMNS.map((column) => (
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
        {footer}
      </TableCard>

      <div className="flex flex-col gap-3 lg:hidden">
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
        <div className="overflow-hidden rounded-xl bg-card [&>div]:border-t-0">{footer}</div>
      </div>
    </>
  );
}
