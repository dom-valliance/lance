import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { breakersLabel, costLine, countLabel, formatGbp, type AgentHealth } from '@/lib/brief-view';
import { humanise } from '@/lib/humanise';
import { formatAgeMinutes } from '@/lib/time';
import { WATCHER_STATE_TONES } from '@/lib/tones';
import { SectionCard } from './section-card';

/**
 * Spec 10.1 item 6: watcher ages, breaker states and cost, in one
 * paragraph. A healthy watcher is a name and an age in the run of the
 * sentence; anything else is a coloured dot badge that names its state, so
 * a problem is legible without reading the whole line.
 */
export function AgentHealthSection({ health }: { health: AgentHealth }) {
  const healthy = health.watchers.filter((watcher) => watcher.state === 'healthy');
  const unwell = health.watchers.filter((watcher) => watcher.state !== 'healthy');
  return (
    <SectionCard
      title="Agent health"
      note={
        <TextLink href="/agents" className="text-xs">
          Agents
        </TextLink>
      }
    >
      <p className="hidden text-[13px] leading-[1.7] lg:block">
        {healthy.length === 0 ? (
          'No watcher is reading. '
        ) : (
          <>
            Watchers read{' '}
            {healthy.map((watcher, index) => (
              <span key={watcher.name}>
                {index === 0 ? null : ', '}
                <span className="font-medium">
                  {watcher.name} {formatAgeMinutes(watcher.ageMinutes)}
                </span>
              </span>
            ))}{' '}
            ago.{' '}
          </>
        )}
        {unwell.map((watcher) => (
          <Badge
            key={watcher.name}
            tone={WATCHER_STATE_TONES[watcher.state]}
            size="sm"
            dot
            className="mr-1.5"
          >
            {watcher.name} {formatAgeMinutes(watcher.ageMinutes)},{' '}
            {humanise(watcher.state).toLowerCase()}
          </Badge>
        ))}
        {breakersLabel(health.breakersOpen)} {costLine(health)}
      </p>

      <p className="text-[13px] text-muted-foreground lg:hidden">
        {countLabel(healthy.length, 'watcher')} healthy
        {unwell.length === 0 ? '' : `, ${countLabel(unwell.length, 'watcher')} not`}.{' '}
        {breakersLabel(health.breakersOpen)} Today so far {formatGbp(health.costTodayGbp)}.
      </p>
    </SectionCard>
  );
}
