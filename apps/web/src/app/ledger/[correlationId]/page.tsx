import { cn } from 'cn';
import { CopyId } from '@/components/copy-id';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { LEDGER_KIND_LABELS, shortId } from '@/lib/humanise';
import {
  formatDelta,
  formatInstantWithSeconds,
  formatTimeWithSeconds,
  ledgerDetail,
  type LedgerEventView,
  proposalIdIn,
  recordUrlIn,
  sourceSystemLabel,
  sourceSystemOf,
} from '@/lib/ledger-view';
import { formatDuration } from '@/lib/time';
import { LEDGER_KIND_TONES, SYSTEM_TONES, TONE_DOT_CLASS } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

const at = (value: Date | string): number =>
  (value instanceof Date ? value : new Date(value)).getTime();

/** "start" for the first event, "end" for the last, "+1 min 49 s" for the rest. */
function deltaLabel(index: number, lastIndex: number, ms: number): string {
  if (index === 0) return 'start';
  if (index === lastIndex) return 'end';
  return `+${formatDelta(ms)}`;
}

/** The system a trail event came from, as a badge, or the word "none". */
function SystemBadge({ value }: { value: string | null }) {
  const system = sourceSystemOf(value);
  if (system === null) {
    return <span className="text-xs text-muted-foreground">{sourceSystemLabel(value)}</span>;
  }
  return (
    <Badge tone={SYSTEM_TONES[system]} size="sm">
      {sourceSystemLabel(value)}
    </Badge>
  );
}

/** One event: the dot, what happened, who did it and the payload behind it. */
function TrailEvent({
  event,
  index,
  lastIndex,
  label,
}: {
  event: LedgerEventView;
  index: number;
  lastIndex: number;
  label: string;
}) {
  const detail = ledgerDetail(event);
  const proposalId = proposalIdIn(event.payload);
  const url = recordUrlIn(event.payload);
  const isLast = index === lastIndex;

  return (
    <li className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-6">
      <div className="hidden lg:block">
        <p className="text-[13px] tabular-nums">{formatInstantWithSeconds(event.ts)}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <div className="grid grid-cols-[24px_1fr] gap-3">
        <div className="flex flex-col items-center">
          <span
            aria-hidden
            className={cn(
              'mt-1 size-3 shrink-0 rounded-full',
              TONE_DOT_CLASS[LEDGER_KIND_TONES[event.kind]],
            )}
          />
          {isLast ? null : <span aria-hidden className="mt-1 w-px flex-1 bg-border" />}
        </div>
        <div className={cn('min-w-0', isLast ? 'pb-0' : 'pb-6')}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">{LEDGER_KIND_LABELS[event.kind]}</span>
            <span className="text-xs tabular-nums text-muted-foreground lg:hidden">
              {formatTimeWithSeconds(event.ts)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground lg:hidden">{label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{event.actor}</span>
            <SystemBadge value={event.sourceSystem} />
          </div>
          {detail === '' ? null : (
            <p className="mt-2 text-[13px] text-muted-foreground">{detail}</p>
          )}
          {proposalId === null && url === null ? null : (
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              {proposalId === null ? null : (
                <span className="text-muted-foreground">
                  Proposal{' '}
                  <TextLink href={`/proposals/${proposalId}`} mono title={proposalId}>
                    {shortId(proposalId, 12)}
                  </TextLink>
                </span>
              )}
              {url === null ? null : (
                <TextLink href={url}>Open in {sourceSystemLabel(event.sourceSystem)}</TextLink>
              )}
            </p>
          )}
          {event.payload === null || event.payload === undefined ? null : (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Payload</summary>
              <pre className="mt-2 overflow-auto rounded-lg bg-background p-3 font-mono text-xs">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function CorrelationPage({
  params,
}: {
  params: Promise<{ correlationId: string }>;
}) {
  const { correlationId } = await params;
  const client = await apiClient();
  const trail = await client.ledger.correlation.query({ correlationId });

  const first = trail[0];
  const last = trail[trail.length - 1];
  const proposalId = trail.reduce<string | null>(
    (found, event) => found ?? proposalIdIn(event.payload),
    null,
  );

  const summary =
    first === undefined || last === undefined ? undefined : (
      <>
        {trail.length === 1
          ? '1 event'
          : `${String(trail.length)} events over ${formatDuration(at(last.ts) - at(first.ts))}`}
        , from {sourceSystemLabel(first.sourceSystem)} to{' '}
        {LEDGER_KIND_LABELS[last.kind].toLowerCase()}.
        {proposalId === null ? null : (
          <>
            {' '}
            Proposal{' '}
            <TextLink href={`/proposals/${proposalId}`} mono title={proposalId}>
              {shortId(proposalId, 12)}
            </TextLink>
            .
          </>
        )}
      </>
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/ledger', label: 'Back to the ledger' }}
        title={
          <>
            Correlation <span className="font-mono text-xl font-medium">{correlationId}</span>
          </>
        }
        {...(summary === undefined ? {} : { summary })}
        actions={<CopyId id={correlationId} />}
      />

      <div className="rounded-xl bg-card p-6">
        {trail.length === 0 ? (
          <EmptyState className="px-0 py-6">
            No events carry that correlation id. Check the id and try again.
          </EmptyState>
        ) : (
          <ol aria-label="Every event in this trail, oldest first" className="flex flex-col">
            {trail.map((event, index) => (
              <TrailEvent
                key={event.id}
                event={event}
                index={index}
                lastIndex={trail.length - 1}
                label={deltaLabel(
                  index,
                  trail.length - 1,
                  first === undefined ? 0 : at(event.ts) - at(first.ts),
                )}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
