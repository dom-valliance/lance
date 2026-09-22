import { cn } from 'cn';
import { ExternalLink } from 'lucide-react';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import type { SourceSystem } from '@/lib/filters';
import { shortId, SYSTEM_LABELS } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { SYSTEM_TONES } from '@/lib/tones';

/** What every claim carries (spec non-negotiable 5): where, which record, when, and a way there. */
export interface ProvenanceSource {
  system: SourceSystem;
  recordId: string;
  observedAt?: string;
  url?: string;
}

/**
 * System badge, record id in mono, observed time, and the external-link
 * glyph when a URL exists. Always visible, never a tooltip.
 */
export function ProvenanceLink({
  source,
  seen = true,
  className,
}: {
  source: ProvenanceSource;
  seen?: boolean;
  className?: string | undefined;
}) {
  const id = shortId(source.recordId);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2 text-[13px]', className)}>
      <Badge tone={SYSTEM_TONES[source.system]} size="sm">
        {SYSTEM_LABELS[source.system]}
      </Badge>
      {source.url === undefined ? (
        <span className="font-mono text-xs" title={source.recordId}>
          {id}
        </span>
      ) : (
        <TextLink href={source.url} mono className="inline-flex items-center gap-1" title={source.recordId}>
          {id}
          <ExternalLink aria-hidden className="size-3" />
        </TextLink>
      )}
      {seen && source.observedAt !== undefined ? (
        <span className="text-xs text-muted-foreground">seen {formatInstant(source.observedAt)}</span>
      ) : null}
    </span>
  );
}
