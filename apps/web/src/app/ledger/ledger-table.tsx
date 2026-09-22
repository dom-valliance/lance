import type { ReactNode } from 'react';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { LEDGER_KIND_LABELS, shortId, SYSTEM_LABELS } from '@/lib/humanise';
import {
  formatInstantWithSeconds,
  formatTimeWithSeconds,
  ledgerDetail,
  sourceSystemOf,
  type LedgerEventView,
} from '@/lib/ledger-view';
import { LEDGER_KIND_TONES, SYSTEM_TONES, TONE_DOT_CLASS } from '@/lib/tones';

/**
 * One page of ledger events, newest first. The same table at every width:
 * the detail column is dropped on a phone and the When and Correlation id
 * columns stay reachable by scrolling sideways.
 */

export function LedgerTable({
  events,
  footer,
}: {
  events: readonly LedgerEventView[];
  /** The paging footer, rendered under the table. */
  footer: ReactNode;
}) {
  return (
    <TableCard>
      <Table caption="Ledger events, newest first" className="text-[13px] tabular-nums">
        <thead>
          <tr>
            <Th className="sticky left-0 bg-card">When</Th>
            <Th>Kind</Th>
            <Th>Actor</Th>
            <Th>Source system</Th>
            <Th className="hidden lg:table-cell">Detail</Th>
            <Th>Correlation id</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const system = sourceSystemOf(event.sourceSystem);
            return (
              <Tr key={event.id}>
                <Td className="sticky left-0 bg-card py-2.5 whitespace-nowrap">
                  <span className="hidden lg:inline">{formatInstantWithSeconds(event.ts)}</span>
                  <span className="lg:hidden">{formatTimeWithSeconds(event.ts)}</span>
                </Td>
                <Td className="py-2.5 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${TONE_DOT_CLASS[LEDGER_KIND_TONES[event.kind]]}`}
                    />
                    {LEDGER_KIND_LABELS[event.kind]}
                  </span>
                </Td>
                <Td className="py-2.5 font-mono text-xs whitespace-nowrap">{event.actor}</Td>
                <Td className="py-2.5">
                  {system === null ? (
                    <span className="text-muted-foreground">none</span>
                  ) : (
                    <Badge tone={SYSTEM_TONES[system]} size="sm">
                      {SYSTEM_LABELS[system]}
                    </Badge>
                  )}
                </Td>
                <Td className="hidden py-2.5 text-muted-foreground lg:table-cell">
                  {ledgerDetail(event)}
                </Td>
                <Td className="py-2.5">
                  <TextLink
                    href={`/ledger/${event.correlationId}`}
                    mono
                    title={event.correlationId}
                  >
                    {shortId(event.correlationId, 12)}
                  </TextLink>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      {footer}
    </TableCard>
  );
}
