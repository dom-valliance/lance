import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ActionForm } from '@/components/action-form';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { ProvenanceLink, type ProvenanceSource } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import {
  canAck,
  canMute,
  canResolve,
  type AlertSeverity,
  type AlertStatus,
} from '@/lib/alert-view';
import { humanise } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { relativeTo } from '@/lib/time';
import { SEVERITY_TONES } from '@/lib/tones';
import { ackAlert, muteAlert, resolveAlert } from './actions';

/**
 * One page of alerts: the table on a desktop and the same rows as cards on
 * a phone. The page fetches, filters and sorts; this renders, with the
 * three state changes as forms inside the row they belong to.
 */

/** The eight columns, in order; `loading.tsx` keeps its own copy of the names. */
const ALERT_COLUMNS = [
  'Severity',
  'Kind',
  'Alert',
  'Count',
  'First seen',
  'Last seen',
  'Provenance',
  'Actions',
];

/** Structurally what `alerts.list` returns, down to the columns shown here. */
export interface AlertRow {
  id: string;
  severity: AlertSeverity;
  status: AlertStatus;
  kind: string;
  title: string;
  body: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  provenance: ProvenanceSource[];
}

/** Every provenance ref an alert carries, each with a link where one exists. */
function Provenance({ provenance }: { provenance: readonly ProvenanceSource[] }) {
  if (provenance.length === 0) {
    return <span className="text-xs text-muted-foreground">None recorded</span>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {provenance.map((ref) => (
        <ProvenanceLink key={`${ref.system}:${ref.recordId}`} source={ref} />
      ))}
    </div>
  );
}

/** Ack, mute and resolve, each offered only while the status still allows it. */
function Actions({
  alert,
  statusLabel,
  size,
}: {
  alert: AlertRow;
  statusLabel: string;
  size: 'sm' | 'lg';
}) {
  const wide = size === 'lg';
  return (
    <div className="flex flex-wrap gap-2">
      {canAck(alert) ? (
        <ActionForm action={ackAlert} className={cn(wide && 'flex-1')}>
          <input type="hidden" name="alertId" value={alert.id} />
          <SubmitButton size="sm" pendingLabel="Acking" className={cn(wide && 'w-full')}>
            Ack
          </SubmitButton>
        </ActionForm>
      ) : null}
      {canMute(alert) ? (
        <ActionForm action={muteAlert} className={cn(wide && 'flex-1')}>
          <input type="hidden" name="alertId" value={alert.id} />
          <SubmitButton
            variant="outline"
            size="sm"
            pendingLabel="Muting"
            className={cn(wide && 'w-full')}
          >
            Mute 24h
          </SubmitButton>
        </ActionForm>
      ) : null}
      {canResolve(alert) ? (
        <ActionForm action={resolveAlert} className={cn(wide && 'flex-1')}>
          <input type="hidden" name="alertId" value={alert.id} />
          <SubmitButton
            variant="outline"
            size="sm"
            pendingLabel="Resolving"
            className={cn(wide && 'w-full')}
          >
            Resolve
          </SubmitButton>
        </ActionForm>
      ) : null}
      {!canAck(alert) && !canMute(alert) && !canResolve(alert) ? (
        <span className="text-xs text-muted-foreground">
          No actions: this alert is {statusLabel.toLowerCase()}.
        </span>
      ) : null}
    </div>
  );
}

export function AlertsTable({
  alerts,
  statusLabels,
  now,
  footer,
}: {
  alerts: readonly AlertRow[];
  /** The page's own words for each status, for the sentence a closed row shows. */
  statusLabels: Record<AlertStatus, string>;
  now: Date;
  /** The paging footer, rendered under the table and under the cards. */
  footer: ReactNode;
}) {
  return (
    <>
      <TableCard className="hidden lg:block">
        <Table caption="Alerts, P0 first, then most recently seen">
          <thead>
            <tr>
              {ALERT_COLUMNS.map((column) => (
                <Th key={column}>{column}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <Tr
                key={alert.id}
                liveId={alert.id}
                {...(alert.severity === 'P0' ? { accent: 'red' as const } : {})}
              >
                <Td>
                  <Badge tone={SEVERITY_TONES[alert.severity]} size="sm">
                    {alert.severity}
                  </Badge>
                </Td>
                <Td>{humanise(alert.kind)}</Td>
                <Td>
                  <p className="font-medium">{alert.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{alert.body}</p>
                </Td>
                <Td>{alert.count}</Td>
                <Td className="whitespace-nowrap">{formatInstant(alert.firstSeen)}</Td>
                <Td className="whitespace-nowrap">
                  {relativeTo(alert.lastSeen, now)}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatInstant(alert.lastSeen)}
                  </p>
                </Td>
                <Td>
                  <Provenance provenance={alert.provenance} />
                </Td>
                <Td>
                  <Actions alert={alert} statusLabel={statusLabels[alert.status]} size="sm" />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {footer}
      </TableCard>

      <ul className="flex flex-col gap-3 lg:hidden">
        {alerts.map((alert) => (
          <li
            key={alert.id}
            data-live-id={alert.id}
            className="flex flex-col gap-3 rounded-xl bg-card p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONES[alert.severity]} size="sm">
                    {alert.severity}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{humanise(alert.kind)}</span>
                </div>
                <p className="mt-1 font-medium">{alert.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{alert.body}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Seen {alert.count} time{alert.count === 1 ? '' : 's'}, first{' '}
              {formatInstant(alert.firstSeen)}, last {relativeTo(alert.lastSeen, now)}
            </p>
            <Provenance provenance={alert.provenance} />
            <Actions alert={alert} statusLabel={statusLabels[alert.status]} size="lg" />
          </li>
        ))}
        <li className="overflow-hidden rounded-xl bg-card [&>div]:border-t-0">{footer}</li>
      </ul>
    </>
  );
}
