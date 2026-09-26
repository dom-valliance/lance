import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm } from '@/components/action-form';
import { Ageing } from '@/components/ageing';
import { KeyValue, KeyValueGrid } from '@/components/key-value';
import { PageHeader } from '@/components/page-header';
import { ProvenanceLink } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { ageingEmphasis } from '@/lib/ageing';
import {
  ageingLabel,
  authorLabel,
  chaseLabel,
  COMMITMENT_DESCRIPTION_MAX_CHARS,
  COMMITMENT_NOTE_MAX_CHARS,
  dueDayOf,
  isCommitmentOpenForAction,
  isCommitmentOverdue,
  sourceStateSentence,
  statusChoices,
  type CommitmentNoteView,
  type CommitmentView,
  type SourceContextView,
} from '@/lib/commitment-view';
import { COMMITMENT_STATUS_LABELS } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { formatDate } from '@/lib/time';
import { COMMITMENT_STATUS_TONES } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';
import {
  addCommitmentNote,
  chaseCommitment,
  editCommitment,
  setCommitmentStatus,
} from '../actions';

export const dynamic = 'force-dynamic';

const DIRECTION_LABELS: Record<CommitmentView['direction'], string> = {
  outbound: 'You owe',
  inbound: 'Owed to you',
};

const KIND_LABELS: Record<SourceContextView['kind'], string> = {
  email: 'Email',
  meeting: 'Meeting',
  record: 'Record',
};

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

function StatusBadge({ commitment }: { commitment: CommitmentView }) {
  const key = isCommitmentOverdue(commitment) ? 'overdue' : commitment.status;
  return (
    <Badge tone={COMMITMENT_STATUS_TONES[key]}>
      {key === 'overdue' ? 'Overdue' : COMMITMENT_STATUS_LABELS[key]}
    </Badge>
  );
}

function Facts({ commitment, now }: { commitment: CommitmentView; now: Date }) {
  const ageing = ageingLabel(commitment, now);
  const inferred = commitment.dueConfidence !== null && commitment.dueConfidence < 1;
  return (
    <KeyValueGrid className="border-t border-border pt-4">
      <KeyValue label="Counterparty">
        {commitment.counterparty.name}
        {commitment.counterparty.email === null ? null : (
          <span className="block text-xs text-muted-foreground">
            {commitment.counterparty.email}
          </span>
        )}
      </KeyValue>
      <KeyValue label="Owed by">{commitment.owner.name}</KeyValue>
      <KeyValue label="Due">
        {commitment.dueAt === null ? (
          <span className="text-muted-foreground">No date</span>
        ) : (
          formatDate(commitment.dueAt)
        )}
        {inferred ? <span className="text-muted-foreground">, read from the source</span> : null}
        <Ageing className="mt-0.5 flex" label={ageing} emphasis={ageingEmphasis(ageing)} />
      </KeyValue>
      <KeyValue label="Chased">
        {chaseLabel(commitment.chaseCount)}
        {commitment.nextChaseAt === null ? null : (
          <span className="block text-xs text-muted-foreground">
            next {formatInstant(commitment.nextChaseAt)}
          </span>
        )}
      </KeyValue>
      <KeyValue label="Recorded">{formatInstant(commitment.createdAt)}</KeyValue>
      <KeyValue label="Last changed">{formatInstant(commitment.updatedAt)}</KeyValue>
    </KeyValueGrid>
  );
}

function SourceBlock({ source }: { source: SourceContextView }) {
  const sentence = sourceStateSentence(source);
  const heading = [
    KIND_LABELS[source.kind],
    source.occurredAt === null ? null : formatInstant(source.occurredAt),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return (
    <article className="flex flex-col gap-3 rounded-lg bg-background px-5 py-4 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 font-medium break-words">{source.title ?? 'Untitled record'}</p>
          <p className="m-0 text-xs text-muted-foreground">{heading}</p>
        </div>
        <ProvenanceLink
          source={{
            system: source.system,
            recordId: source.recordId,
            observedAt: source.observedAt,
            ...(source.url === null ? {} : { url: source.url }),
          }}
          seen={false}
        />
      </div>

      {source.from === null && source.people.length === 0 ? null : (
        <dl className="m-0 grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {source.from === null ? null : (
            <>
              <dt className="text-muted-foreground">From</dt>
              <dd className="m-0 break-words">{source.from}</dd>
            </>
          )}
          {source.people.length === 0 ? null : (
            <>
              <dt className="text-muted-foreground">{source.kind === 'meeting' ? 'With' : 'To'}</dt>
              <dd className="m-0 break-words">{source.people.join(', ')}</dd>
            </>
          )}
        </dl>
      )}

      {source.excerpt === null ? null : (
        <blockquote className="m-0 border-l-2 border-border pl-3 leading-relaxed break-words text-muted-foreground">
          {source.excerpt.before}
          <mark className="rounded-sm bg-brand-soft px-0.5 text-foreground">
            {source.excerpt.quote}
          </mark>
          {source.excerpt.after}
        </blockquote>
      )}

      {source.state === 'found' && source.excerpt === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          The quote is not in the text Lance holds for this record
          {source.fallback === null ? '.' : ', so here is its summary.'}
        </p>
      ) : null}
      {source.fallback === null ? null : (
        <p className="m-0 leading-relaxed break-words whitespace-pre-line">{source.fallback}</p>
      )}
      {sentence === null ? null : <p className="m-0 text-xs text-muted-foreground">{sentence}</p>}
    </article>
  );
}

function Notes({ commitmentId, notes }: { commitmentId: string; notes: CommitmentNoteView[] }) {
  return (
    <Card
      title="Notes"
      aside={<span className="text-xs text-muted-foreground">{notes.length}</span>}
    >
      {notes.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          No notes yet. What you add here is kept with the commitment and recorded in the ledger.
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {notes.map((note) => (
            <li key={note.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium">{authorLabel(note.author)}</span>
                <span className="text-muted-foreground">{formatInstant(note.createdAt)}</span>
              </div>
              <p className="m-0 text-[13px] leading-relaxed break-words whitespace-pre-line">
                {note.body}
              </p>
            </li>
          ))}
        </ol>
      )}
      <ActionForm
        action={addCommitmentNote}
        className="flex flex-col gap-3 border-t border-border pt-4"
      >
        <input type="hidden" name="commitmentId" value={commitmentId} />
        <Field label="Add a note">
          <Textarea
            name="body"
            rows={3}
            required
            maxLength={COMMITMENT_NOTE_MAX_CHARS}
            placeholder="What changed, what was agreed, what to remember"
          />
        </Field>
        <SubmitButton pendingLabel="Adding" variant="outline" className="w-fit">
          Add note
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}

function StatusControl({ commitment }: { commitment: CommitmentView }) {
  const choices = statusChoices(commitment);
  const chaseable = commitment.direction === 'inbound' && isCommitmentOpenForAction(commitment);
  return (
    <>
      {chaseable ? (
        <ActionForm action={chaseCommitment}>
          <input type="hidden" name="commitmentId" value={commitment.id} />
          <SubmitButton pendingLabel="Queuing" className="w-full">
            Chase {commitment.counterparty.name}
          </SubmitButton>
        </ActionForm>
      ) : null}
      <ActionForm action={setCommitmentStatus} className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Change status</h3>
        <input type="hidden" name="commitmentId" value={commitment.id} />
        <Field label="Move to">
          <Select name="status" required defaultValue={choices[0]}>
            {choices.map((status) => (
              <option key={status} value={status}>
                {COMMITMENT_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason, required to drop">
          <Input name="reason" maxLength={COMMITMENT_NOTE_MAX_CHARS} placeholder="Why it moves" />
        </Field>
        <SubmitButton pendingLabel="Changing" variant="outline" className="w-fit">
          Change status
        </SubmitButton>
        <p className="m-0 text-xs text-muted-foreground">
          Recorded in the ledger with your reason. Nothing is sent to {commitment.counterparty.name}
          .
        </p>
      </ActionForm>
    </>
  );
}

function EditForm({ commitment }: { commitment: CommitmentView }) {
  return (
    <ActionForm action={editCommitment} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Edit</h3>
      <input type="hidden" name="commitmentId" value={commitment.id} />
      <Field label="What was promised">
        <Textarea
          name="description"
          rows={3}
          required
          maxLength={COMMITMENT_DESCRIPTION_MAX_CHARS}
          defaultValue={commitment.description}
        />
      </Field>
      <Field label="Due date" hint="17:00 London time on that day. Leave empty for no date.">
        <Input name="dueDay" type="date" defaultValue={dueDayOf(commitment.dueAt)} />
      </Field>
      <SubmitButton pendingLabel="Saving" variant="outline" className="w-fit">
        Save changes
      </SubmitButton>
      <p className="m-0 text-xs text-muted-foreground">
        The quote and its sources stay as Lance found them.
      </p>
    </ActionForm>
  );
}

export default async function CommitmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date();
  const client = await apiClient();

  const detail = await client.commitments.detail.query({ id });
  if (detail === null) notFound();
  const { commitment, notes, sources } = detail;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{
          href: `/commitments?direction=${commitment.direction}`,
          label: 'Back to commitments',
        }}
        title={commitment.description}
        summary={`${DIRECTION_LABELS[commitment.direction]}, with ${commitment.counterparty.name}`}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge commitment={commitment} />
              <Badge tone="neutral-strong">{DIRECTION_LABELS[commitment.direction]}</Badge>
            </div>
            <blockquote className="m-0 border-l-2 border-brand pl-3 text-[15px] leading-relaxed break-words">
              &quot;{commitment.evidenceQuote}&quot;
            </blockquote>
            <Facts commitment={commitment} now={now} />
          </Card>

          <Card title="Where it came from">
            {sources.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">
                No provenance was recorded for this commitment.
              </p>
            ) : (
              sources.map((source) => (
                <SourceBlock key={`${source.system}:${source.recordId}`} source={source} />
              ))
            )}
          </Card>

          <Notes commitmentId={commitment.id} notes={notes} />
        </div>

        <Card
          title="Update"
          aside={<StatusBadge commitment={commitment} />}
          className="self-start ring-1 ring-border lg:sticky lg:top-8"
        >
          <StatusControl commitment={commitment} />
          <Separator />
          <EditForm commitment={commitment} />
        </Card>
      </div>
    </div>
  );
}
