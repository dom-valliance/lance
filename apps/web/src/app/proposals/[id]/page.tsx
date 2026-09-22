import { notFound } from 'next/navigation';
import { cn } from 'cn';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActionForm } from '@/components/action-form';
import { KeyValue, KeyValueGrid } from '@/components/key-value';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { Timeline, type TimelineItem } from '@/components/timeline';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { ActionClass } from '@/lib/filters';
import {
  ACTION_CLASS_LABELS,
  COUNTERPARTY_LABELS,
  DECISION_LABELS,
  LEDGER_KIND_LABELS,
  PROPOSAL_STATUS_LABELS,
  shortId,
  SYSTEM_LABELS,
} from '@/lib/humanise';
import {
  allowedActions,
  diffPayload,
  editableFields,
  fieldLabel,
  formatInstant,
  holdBar,
  HOLD_DAY_END_HOUR,
  HOLD_DAY_START_HOUR,
  payloadView,
  REJECT_REASONS,
  statusSentence,
  summariseLedgerPayload,
  type PayloadView,
  type ProposalStatus,
} from '@/lib/proposal-view';
import { formatTime, relativeTo } from '@/lib/time';
import {
  DECISION_TONES,
  LEDGER_KIND_TONES,
  PROPOSAL_STATUS_TONES,
  SYSTEM_TONES,
} from '@/lib/tones';
import { apiClient } from '@/lib/trpc';
import { approveProposal, editProposal, rejectProposal, snoozeProposal } from '../actions';

export const dynamic = 'force-dynamic';

/** A textarea long enough to read a paragraph in; a one-line field stays short. */
const LONG_VALUE = 120;

const STATUS_HISTORY_ID = 'status-history';

const isOpen = (status: ProposalStatus): boolean => status === 'pending' || status === 'held';

function Card({
  title,
  aside,
  className,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-xl bg-card p-6', className)}>
      {title === undefined ? null : (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** The inset panel each payload read view sits in. */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg bg-background px-6 py-5 text-[13px]', className)}>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function HoldStrip({ start, end, timeZone }: { start: string; end: string; timeZone: string }) {
  const bar = holdBar(start, end);
  const hours = `${formatTime(start)} to ${formatTime(end)}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground">
        {hours}, {timeZone}
      </div>
      {bar === null ? null : (
        <div className="flex flex-col gap-1">
          <div
            role="img"
            aria-label={`The hold runs ${hours} within the working day`}
            className="relative h-9 rounded-md bg-muted"
          >
            <div
              style={{ left: `${String(bar.left)}%`, width: `${String(bar.width)}%` }}
              className="absolute inset-y-1 rounded-sm border border-l-2 border-sem-peach-line border-l-brand bg-brand-soft"
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{String(HOLD_DAY_START_HOUR).padStart(2, '0')}:00</span>
            <span>{String(HOLD_DAY_END_HOUR)}:00</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PayloadBody({ view }: { view: PayloadView }) {
  switch (view.kind) {
    case 'email':
      return (
        <Panel className="flex flex-col gap-4">
          <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <Row label="To">{view.to.length === 0 ? 'Not recorded' : view.to.join(', ')}</Row>
            {view.cc.length === 0 ? null : <Row label="Cc">{view.cc.join(', ')}</Row>}
            <Row label="Subject">
              <span className="font-medium">{view.subject ?? 'No subject'}</span>
            </Row>
            {view.replyToMessageId === null ? null : (
              <Row label="Thread">
                <span className="font-mono text-xs text-muted-foreground">
                  reply to {shortId(view.replyToMessageId)}
                </span>
              </Row>
            )}
          </dl>
          <div className="border-t border-border pt-4 leading-relaxed whitespace-pre-wrap">
            {view.body ?? 'The draft carries no body text.'}
          </div>
        </Panel>
      );
    case 'task':
    case 'fields':
      return (
        <Panel>
          {view.fields.length === 0 ? (
            <p className="m-0 text-muted-foreground">The payload carries no readable fields.</p>
          ) : (
            <KeyValueGrid>
              {view.fields.map((field) => (
                <KeyValue key={field.name} label={field.name}>
                  {field.value}
                </KeyValue>
              ))}
            </KeyValueGrid>
          )}
        </Panel>
      );
    case 'hold':
      return (
        <Panel className="flex flex-col gap-3">
          <div className="text-sm font-medium">{view.title ?? 'Untitled hold'}</div>
          {view.start === null || view.end === null ? (
            <p className="m-0 text-muted-foreground">The hold carries no start and end.</p>
          ) : (
            <HoldStrip start={view.start} end={view.end} timeZone={view.timeZone} />
          )}
        </Panel>
      );
    case 'transition':
      return (
        <Panel className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)] items-center gap-4">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{view.beforeLabel}</div>
            <div className="font-medium">{view.before}</div>
          </div>
          <ArrowRight aria-hidden className="size-5 text-muted-foreground" />
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{view.afterLabel}</div>
            <div className="font-medium">{view.after}</div>
          </div>
          <p className="col-span-full m-0 border-t border-border pt-3 text-muted-foreground">
            {view.messages === 1 ? '1 message' : `${String(view.messages)} messages`}.
          </p>
        </Panel>
      );
  }
}

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date();
  const client = await apiClient();

  const proposal = await client.proposals.get.query({ proposalId: id });
  if (proposal === null) notFound();

  const trail = await client.ledger.correlation.query({ correlationId: proposal.correlationId });
  const changes = diffPayload(proposal.payload, proposal.editedPayload);
  const actions = allowedActions(proposal.status);
  const sentence = statusSentence(proposal.status);
  const open = isOpen(proposal.status);
  const actionClass: ActionClass = proposal.actionClass;

  const events: TimelineItem[] = trail.map((event) => {
    const detail = summariseLedgerPayload(event.payload);
    return {
      key: event.id,
      tone: LEDGER_KIND_TONES[event.kind],
      title: LEDGER_KIND_LABELS[event.kind],
      meta: (
        <>
          <span className="text-xs text-muted-foreground">{formatInstant(event.ts)}</span>
          <span className="font-mono text-xs text-muted-foreground">{event.actor}</span>
        </>
      ),
      ...(detail === '' ? {} : { body: detail }),
    };
  });

  const approve = (size: 'default' | 'lg', className: string) => (
    <ActionForm action={approveProposal} className={className}>
      <input type="hidden" name="proposalId" value={proposal.id} />
      <SubmitButton pendingLabel="Approving" size={size} className="w-full">
        Approve
      </SubmitButton>
    </ActionForm>
  );

  const snooze = (size: 'default' | 'lg') => (
    <ActionForm action={snoozeProposal}>
      <input type="hidden" name="proposalId" value={proposal.id} />
      <SubmitButton pendingLabel="Snoozing" variant="outline" size={size}>
        Snooze 4h
      </SubmitButton>
    </ActionForm>
  );

  return (
    <div className={cn('flex flex-col gap-6', open && 'pb-24 lg:pb-0')}>
      <PageHeader
        back={{ href: '/proposals', label: 'Back to proposals' }}
        title={proposal.preview}
        actions={<LiveRefresh streamUrl="/api/events" watch="proposal" indicator />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <Card className="lg:col-start-1 lg:row-start-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>
              {PROPOSAL_STATUS_LABELS[proposal.status]}
            </Badge>
            <Badge tone="neutral-strong">{ACTION_CLASS_LABELS[actionClass]}</Badge>
            <Badge tone="neutral-strong">{COUNTERPARTY_LABELS[proposal.counterpartyClass]}</Badge>
            <Badge tone={SYSTEM_TONES[proposal.targetSystem]}>
              {SYSTEM_LABELS[proposal.targetSystem]}
            </Badge>
          </div>

          <p className="m-0 text-muted-foreground">{proposal.rationale}</p>

          <KeyValueGrid className="border-t border-border pt-4">
            <KeyValue label="Policy cell">
              {ACTION_CLASS_LABELS[actionClass]} / {COUNTERPARTY_LABELS[proposal.counterpartyClass]}{' '}
              / {SYSTEM_LABELS[proposal.targetSystem]}
            </KeyValue>
            <KeyValue label="Policy decision">
              <Badge tone={DECISION_TONES[proposal.policyDecision]}>
                {DECISION_LABELS[proposal.policyDecision]}
              </Badge>
            </KeyValue>
            <KeyValue label="Expires">
              {formatInstant(proposal.expiresAt)}{' '}
              <span className="text-muted-foreground">({relativeTo(proposal.expiresAt, now)})</span>
            </KeyValue>
            <KeyValue label="Correlation id">
              <TextLink href={`/ledger/${proposal.correlationId}`} mono>
                {proposal.correlationId}
              </TextLink>
            </KeyValue>
          </KeyValueGrid>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h2 className="text-xs font-medium text-muted-foreground">Provenance</h2>
            {proposal.provenance.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">
                No provenance was recorded for this proposal.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {proposal.provenance.map((ref) => (
                  <li key={`${ref.system}:${ref.recordId}`}>
                    <ProvenanceLink source={ref} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card
          title="Decide"
          aside={
            <Badge tone={PROPOSAL_STATUS_TONES[proposal.status]}>
              {PROPOSAL_STATUS_LABELS[proposal.status]}
            </Badge>
          }
          className="self-start ring-1 ring-border lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1"
        >
          {sentence === null ? null : (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm text-muted-foreground">{sentence}</p>
              {proposal.status === 'failed' ? (
                <TextLink href={`#${STATUS_HISTORY_ID}`} className="text-[13px]">
                  Check the status history
                </TextLink>
              ) : null}
            </div>
          )}

          {!actions.includes('approve') ? null : (
            <div className="flex flex-wrap items-start gap-2">
              {approve('default', 'flex-1')}
              {actions.includes('snooze') ? snooze('default') : null}
            </div>
          )}

          {!actions.includes('edit') ? null : (
            <>
              <Separator />
              <ActionForm action={editProposal} className="flex flex-col gap-3">
                <h3 className="text-sm font-medium">Edit</h3>
                <input type="hidden" name="proposalId" value={proposal.id} />
                {editableFields(proposal.payload).map(([field, value]) => (
                  <Field key={field} label={fieldLabel(field)}>
                    <Textarea
                      name={`field:${field}`}
                      defaultValue={value}
                      rows={value.length > LONG_VALUE ? 4 : 2}
                    />
                  </Field>
                ))}
                <SubmitButton pendingLabel="Saving" variant="outline" className="w-fit">
                  Save the edit and execute
                </SubmitButton>
              </ActionForm>
            </>
          )}

          {!actions.includes('reject') ? null : (
            <>
              <Separator />
              <ActionForm action={rejectProposal} className="flex flex-col gap-3">
                <h3 className="text-sm font-medium">Reject</h3>
                <input type="hidden" name="proposalId" value={proposal.id} />
                <Field label="Reason, required">
                  <Select name="reasonCode" required defaultValue="">
                    <option value="" disabled>
                      Choose a reason
                    </option>
                    {REJECT_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Note, optional">
                  <Textarea
                    name="note"
                    rows={2}
                    placeholder="Anything Lance should learn from this"
                  />
                </Field>
                <SubmitButton pendingLabel="Rejecting" variant="destructive" className="w-fit">
                  Reject
                </SubmitButton>
              </ActionForm>
            </>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-2">
          <Card title={ACTION_CLASS_LABELS[actionClass]}>
            <PayloadBody view={payloadView(actionClass, proposal.payload)} />
          </Card>

          {changes.length === 0 ? null : (
            <Card title="What the edit changed">
              <table className="w-full table-fixed border-collapse text-left text-[13px]">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="w-28 py-2 pr-3 font-medium">
                      Field
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Originally
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      After the edit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr key={change.field} className="border-t border-border">
                      <td className="py-2.5 pr-3 align-top">{fieldLabel(change.field)}</td>
                      <td className="px-3 py-2.5 align-top text-muted-foreground line-through whitespace-pre-wrap">
                        {change.before}
                      </td>
                      <td className="bg-sem-green-bg/50 px-3 py-2.5 align-top whitespace-pre-wrap">
                        {change.after}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card
            title="Status history"
            aside={
              <TextLink href={`/ledger/${proposal.correlationId}`} className="text-xs">
                Full trail in the ledger
              </TextLink>
            }
            className="scroll-mt-8"
          >
            <div id={STATUS_HISTORY_ID}>
              {events.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">
                  No ledger events carry this correlation id yet.
                </p>
              ) : (
                <Timeline label="Status history" items={events} />
              )}
            </div>
          </Card>
        </div>
      </div>

      {!open ? null : (
        <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-border bg-sidebar p-3 lg:hidden">
          {approve('lg', 'flex-1')}
          {actions.includes('snooze') ? snooze('lg') : null}
        </div>
      )}
    </div>
  );
}
