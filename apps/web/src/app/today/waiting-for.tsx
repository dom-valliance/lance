import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { EmptyState } from '@/components/empty-state';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { chaseCommitment } from '@/app/commitments/actions';
import { chaseLabel, commitmentAgeing, counterpartyLabel, type WaitingFor } from '@/lib/brief-view';

/**
 * Spec 10.1 item 4: inbound commitments past their chase date. Chase is
 * the Commitments page's own action, so a chase started here and a chase
 * started there create the same `draft_email` proposal and nothing about
 * the policy path is duplicated.
 */
export function WaitingForSection({ waitingFor }: { waitingFor: WaitingFor[] }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Waiting for</h2>
        <TextLink href="/commitments" className="text-xs">
          All commitments
        </TextLink>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Inbound commitments past their chase date. Chase drafts an email for your approval.
      </p>

      {waitingFor.length === 0 ? (
        <EmptyState className="px-0 py-6">Nobody owes you anything overdue today.</EmptyState>
      ) : (
        <ul className="flex flex-col">
          {waitingFor.map((item) => {
            const ageing = commitmentAgeing(item.dueAt, item.overdueDays);
            return (
              <li
                key={item.commitmentId}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-border py-3 first:border-t-0 first:pt-0"
              >
                <div className="min-w-0">
                  <TextLink href="/commitments" tone="foreground" className="text-sm">
                    {item.description}
                  </TextLink>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{counterpartyLabel(item.counterparty, item.organisation)}</span>
                    <span aria-hidden>·</span>
                    <Ageing label={ageing.label} emphasis={ageing.emphasis} />
                    <span aria-hidden>·</span>
                    <span>{chaseLabel(item.chaseCount)}</span>
                    <span aria-hidden>·</span>
                    <ProvenanceLink source={item.provenance} seen={false} />
                  </p>
                </div>
                {item.pendingChaseProposalId === null ? (
                  <ActionForm action={chaseCommitment}>
                    <input type="hidden" name="commitmentId" value={item.commitmentId} />
                    <SubmitButton
                      variant="outline"
                      size="sm"
                      pendingLabel="Chasing"
                      className="h-11 lg:h-8"
                    >
                      Chase
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <TextLink
                    href={`/proposals/${item.pendingChaseProposalId}`}
                    className="inline-flex min-h-11 items-center gap-1.5 text-xs lg:min-h-0"
                  >
                    <span aria-hidden className="size-1.5 rounded-full bg-brand" />
                    Chase pending
                  </TextLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
