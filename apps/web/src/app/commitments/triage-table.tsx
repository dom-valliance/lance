import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { ageingEmphasis } from '@/lib/ageing';
import {
  ageingLabel,
  chaseLabel,
  commitmentHref,
  evidenceLine,
  type CommitmentView,
} from '@/lib/commitment-view';
import { formatInstant } from '@/lib/proposal-view';
import { formatDate } from '@/lib/time';
import { confirmCommitment, dismissCommitment } from './actions';

/**
 * The To confirm list (ADR 0037): inbound commitments Lance could not
 * place, as a table on a desktop and cards on a phone. Each row answers
 * Owed to me, which puts it on the board, or Not mine, which drops it.
 */

/** The six columns, in order. */
const COLUMNS = ['Commitment', 'Counterparty', 'Due', 'Chased', 'Provenance', 'Actions'];

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
          <TextLink href={commitmentHref(commitment.id)} tone="foreground" className="font-medium">
            {commitment.description}
          </TextLink>
          <Badge tone="neutral-strong" size="sm">
            Unconfirmed
          </Badge>
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

/** A triage row's two answers: the promise was made to Dom, or to someone else. */
function TriageActions({ commitment, size }: { commitment: CommitmentView; size: 'sm' | 'lg' }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm action={confirmCommitment} className={cn(size === 'lg' && 'flex-1')}>
        <input type="hidden" name="commitmentId" value={commitment.id} />
        <SubmitButton size={size} pendingLabel="Moving" className={cn(size === 'lg' && 'w-full')}>
          Owed to me
        </SubmitButton>
      </ActionForm>
      <ActionForm action={dismissCommitment}>
        <input type="hidden" name="commitmentId" value={commitment.id} />
        <SubmitButton variant="ghost" size={size} pendingLabel="Dropping">
          Not mine
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

export function TriageTable({
  commitments,
  now,
  footer,
}: {
  commitments: readonly CommitmentView[];
  now: Date;
  /** The paging footer, rendered under the table and under the cards. */
  footer: ReactNode;
}) {
  return (
    <>
      <TableCard className="hidden lg:block">
        <Table caption="Commitments that may be owed to Dom, to confirm">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <Th key={column}>{column}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {commitments.map((commitment) => (
              <Tr key={commitment.id}>
                <RowCells commitment={commitment} now={now} />
                <Td>
                  <TriageActions commitment={commitment} size="sm" />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {footer}
      </TableCard>

      <ul className="flex flex-col gap-3 lg:hidden">
        {commitments.map((commitment) => {
          const ageing = ageingLabel(commitment, now);
          const firstRef = commitment.sourceRefs[0];
          return (
            <li key={commitment.id} className="flex flex-col gap-3 rounded-xl bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <TextLink
                  href={commitmentHref(commitment.id)}
                  tone="foreground"
                  className="font-medium"
                >
                  {commitment.description}
                </TextLink>
                <Badge tone="neutral-strong" size="sm">
                  Unconfirmed
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{evidenceLine(commitment)}</p>
              <p className="text-xs text-muted-foreground">
                {commitment.counterparty.name} ·{' '}
                {commitment.dueAt === null ? 'no date' : formatDate(commitment.dueAt)},{' '}
                <Ageing label={ageing} emphasis={ageingEmphasis(ageing)} />
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
              <TriageActions commitment={commitment} size="lg" />
            </li>
          );
        })}
        <li className="overflow-hidden rounded-xl bg-card [&>div]:border-t-0">{footer}</li>
      </ul>
    </>
  );
}
