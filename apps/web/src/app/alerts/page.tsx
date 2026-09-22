import { ActionForm } from '@/components/action-form';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { ProvenanceLink, type ProvenanceSource } from '@/components/provenance';
import { SubmitButton } from '@/components/submit-button';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import {
  ALERT_SEVERITY_FILTERS,
  ALERT_STATUS_FILTERS,
  alertSeverityFilterFrom,
  alertSeveritySelected,
  alertStatusFilterFrom,
  alertStatusSelected,
  canAck,
  canMute,
  canResolve,
  sortAlerts,
  type AlertSeverityFilter,
  type AlertStatusFilter,
} from '@/lib/alert-view';
import { type SearchParams } from '@/lib/filters';
import { humanise } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { relativeTo } from '@/lib/time';
import { SEVERITY_TONES } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';
import { ackAlert, muteAlert, resolveAlert } from './actions';

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 200;

const STATUS_LABELS: Record<AlertStatusFilter, string> = {
  open: 'Open',
  acked: 'Acked',
  resolved: 'Resolved',
  suppressed: 'Muted',
  all: 'All',
};

const SEVERITY_LABELS: Record<AlertSeverityFilter, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  all: 'All',
};

/** A link for this page that keeps both current filters except the one being changed. */
function filterHref(
  current: { status: AlertStatusFilter; severity: AlertSeverityFilter },
  change: Partial<{ status: AlertStatusFilter; severity: AlertSeverityFilter }>,
): string {
  const next = { ...current, ...change };
  const query = new URLSearchParams();
  if (next.status !== 'open') query.set('status', next.status);
  if (next.severity !== 'all') query.set('severity', next.severity);
  const search = query.toString();
  return search === '' ? '/alerts' : `/alerts?${search}`;
}

/** Every provenance ref an alert carries, each with a link where one exists. */
function Provenance({ provenance }: { provenance: ProvenanceSource[] }) {
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

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = alertStatusSelected(params);
  const severity = alertSeveritySelected(params);
  const current = { status, severity };
  const now = new Date();

  const client = await apiClient();
  const statusFilter = alertStatusFilterFrom(params);
  const severityFilter = alertSeverityFilterFrom(params);
  const page = await client.alerts.list.query({
    limit: PAGE_LIMIT,
    ...(statusFilter === undefined ? {} : { status: statusFilter }),
    ...(severityFilter === undefined ? {} : { severity: severityFilter }),
  });
  const alerts = sortAlerts(page.items);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Alerts"
        summary="Open, acknowledged, resolved and muted alerts, each with provenance and the actions to change its state."
        actions={<LiveRefresh streamUrl="/api/events" watch="alert" indicator />}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <FilterLinks
            label="Status"
            options={ALERT_STATUS_FILTERS.map((value) => ({
              label: STATUS_LABELS[value],
              href: filterHref(current, { status: value }),
              active: status === value,
            }))}
          />
          <FilterLinks
            label="Severity"
            options={ALERT_SEVERITY_FILTERS.map((value) => ({
              label: SEVERITY_LABELS[value],
              href: filterHref(current, { severity: value }),
              active: severity === value,
            }))}
          />
        </div>
        <p className="text-xs text-muted-foreground">Sorted P0 first, then most recently seen</p>
      </div>

      {alerts.length === 0 ? (
        <TableCard>
          <EmptyState>
            No alerts match these filters.{' '}
            <TextLink href={filterHref(current, { status: 'open', severity: 'all' })}>
              Clear them
            </TextLink>{' '}
            to see everything open.
          </EmptyState>
        </TableCard>
      ) : (
        <>
          <TableCard className="hidden lg:block">
            <Table caption="Alerts, P0 first, then most recently seen">
              <thead>
                <tr>
                  <Th>Severity</Th>
                  <Th>Kind</Th>
                  <Th>Alert</Th>
                  <Th>Count</Th>
                  <Th>First seen</Th>
                  <Th>Last seen</Th>
                  <Th>Provenance</Th>
                  <Th>Actions</Th>
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
                      <div className="flex flex-wrap gap-2">
                        {canAck(alert) ? (
                          <ActionForm action={ackAlert}>
                            <input type="hidden" name="alertId" value={alert.id} />
                            <SubmitButton size="sm" pendingLabel="Acking">
                              Ack
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        {canMute(alert) ? (
                          <ActionForm action={muteAlert}>
                            <input type="hidden" name="alertId" value={alert.id} />
                            <SubmitButton variant="outline" size="sm" pendingLabel="Muting">
                              Mute 24h
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        {canResolve(alert) ? (
                          <ActionForm action={resolveAlert}>
                            <input type="hidden" name="alertId" value={alert.id} />
                            <SubmitButton variant="outline" size="sm" pendingLabel="Resolving">
                              Resolve
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        {!canAck(alert) && !canMute(alert) && !canResolve(alert) ? (
                          <span className="text-xs text-muted-foreground">
                            No actions: this alert is {STATUS_LABELS[alert.status].toLowerCase()}.
                          </span>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
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
                <div className="flex flex-wrap gap-2">
                  {canAck(alert) ? (
                    <ActionForm action={ackAlert} className="flex-1">
                      <input type="hidden" name="alertId" value={alert.id} />
                      <SubmitButton size="sm" pendingLabel="Acking" className="w-full">
                        Ack
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {canMute(alert) ? (
                    <ActionForm action={muteAlert} className="flex-1">
                      <input type="hidden" name="alertId" value={alert.id} />
                      <SubmitButton
                        variant="outline"
                        size="sm"
                        pendingLabel="Muting"
                        className="w-full"
                      >
                        Mute 24h
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {canResolve(alert) ? (
                    <ActionForm action={resolveAlert} className="flex-1">
                      <input type="hidden" name="alertId" value={alert.id} />
                      <SubmitButton
                        variant="outline"
                        size="sm"
                        pendingLabel="Resolving"
                        className="w-full"
                      >
                        Resolve
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  {!canAck(alert) && !canMute(alert) && !canResolve(alert) ? (
                    <span className="text-xs text-muted-foreground">
                      No actions: this alert is {STATUS_LABELS[alert.status].toLowerCase()}.
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
