import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { countLabel, overnightWindowLabel, type Overnight } from '@/lib/brief-view';
import { ACTION_CLASS_LABELS } from '@/lib/humanise';
import { formatTime } from '@/lib/time';
import { SEVERITY_TONES } from '@/lib/tones';
import { GroupHeading, SectionCard } from './section-card';

/** The brief lists three proposals; the rest are a link to the queue. */
const TOP_AWAITING = 3;

/** Spec 10.1 item 5: what Lance saw, raised and did while Dom was away. */
export function OvernightSection({ overnight }: { overnight: Overnight }) {
  const more = Math.max(overnight.awaiting.count - TOP_AWAITING, 0);
  return (
    <SectionCard title="Overnight" note={overnightWindowLabel(overnight.from, overnight.to)}>
      <div className="hidden gap-6 lg:grid lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <GroupHeading>Alerts raised, {overnight.alerts.length}</GroupHeading>
          {overnight.alerts.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing was raised.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {overnight.alerts.map((alert) => (
                <li key={alert.alertId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={SEVERITY_TONES[alert.severity]} size="xs">
                    {alert.severity}
                  </Badge>
                  <TextLink href="/alerts" tone="foreground">
                    {alert.title}
                  </TextLink>
                  <span className="text-xs text-muted-foreground">{formatTime(alert.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <GroupHeading>Awaiting your decision, {overnight.awaiting.count}</GroupHeading>
          {overnight.awaiting.top.length === 0 ? (
            <p className="text-xs text-muted-foreground">The queue is empty.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {overnight.awaiting.top.slice(0, TOP_AWAITING).map((proposal) => (
                <li key={proposal.proposalId} className="text-sm">
                  <TextLink href={`/proposals/${proposal.proposalId}`} tone="foreground">
                    {proposal.preview}
                  </TextLink>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ACTION_CLASS_LABELS[proposal.actionClass].toLowerCase()}, expires{' '}
                    {formatTime(proposal.expiresAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {more === 0 ? null : (
            <p className="text-xs">
              <TextLink href="/proposals">and {more} more</TextLink>
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <GroupHeading>Executed automatically, {overnight.executed.length}</GroupHeading>
          {overnight.executed.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing ran on its own.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {overnight.executed.map((executed) => (
                <li key={executed.correlationId}>
                  {executed.summary}{' '}
                  <TextLink href={`/ledger/${executed.correlationId}`} mono>
                    {executed.correlationId}
                  </TextLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground lg:hidden">
        {countLabel(overnight.alerts.length, 'alert')} raised <span aria-hidden>·</span>{' '}
        <TextLink href="/proposals">{overnight.awaiting.count} awaiting decision</TextLink>{' '}
        <span aria-hidden>·</span> {overnight.executed.length} executed automatically
      </p>
    </SectionCard>
  );
}
