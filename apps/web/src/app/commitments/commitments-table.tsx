import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { ageingEmphasis } from '@/lib/ageing';
import {
  ageingLabel,
  chaseLabel,
  chasePhrase,
  commitmentBadgeFor,
  evidenceLine,
  firstName,
  isCommitmentOpenForAction,
  isCommitmentOverdue,
  type CommitmentDirection,
  type CommitmentStatus,
  type CommitmentView,
} from '@/lib/commitment-view';
import { COMMITMENT_STATUS_LABELS } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { formatDate } from '@/lib/time';
import { COMMITMENT_STATUS_TONES } from '@/lib/tones';
import { chaseCommitment, dropCommitment, markCommitmentDone } from './actions';
import { CommitmentCard, CommitmentRowPair } from './drop-disclosure';

/**
 * One page of commitments: the table on a desktop and the same rows as
 * cards on a phone. Both put Drop behind the inline disclosure that asks
 * for a reason. The page fetches, filters and sorts; this renders.
 */

/** The six columns, in order; `loading.tsx` keeps its own copy of the names. */
const COMMITMENT_COLUMNS = ['Commitment', 'Counterparty', 'Due', 'Chased', 'Provenance', 'Actions'];

const BADGE_LABELS: Record<CommitmentStatus | 'overdue', string> = {
  ...COMMITMENT_STATUS_LABELS,
  overdue: 'Overdue',
};

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

export function CommitmentsTable({
  commitments,
  direction,
  now,
  footer,
}: {
  commitments: readonly CommitmentView[];
  /** The tab being shown; Chase is offered only where someone else owes the answer. */
  direction: CommitmentDirection;
  now: Date;
  /** The paging footer, rendered under the table and under the cards. */
  footer: ReactNode;
}) {
  return (
    <>
      <TableCard className="hidden lg:block">
        <Table
          caption={`Commitments ${direction === 'outbound' ? 'Dom owes' : 'owed to Dom'}, overdue first`}
        >
          <thead>
            <tr>
              {COMMITMENT_COLUMNS.map((column) => (
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
                  actions={<OpenActions commitment={commitment} direction={direction} size="sm" />}
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
        {footer}
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
        <li className="overflow-hidden rounded-xl bg-card [&>div]:border-t-0">{footer}</li>
      </ul>
    </>
  );
}
