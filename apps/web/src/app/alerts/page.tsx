import { TableCard } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
import {
  ALERT_SEVERITY_FILTERS,
  ALERT_STATUS_FILTERS,
  alertSeverityFilterFrom,
  alertSeveritySelected,
  alertStatusFilterFrom,
  alertStatusSelected,
  sortAlerts,
  type AlertSeverityFilter,
  type AlertStatusFilter,
} from '@/lib/alert-view';
import { type SearchParams } from '@/lib/filters';
import { cursorFrom, pageLinks, pageSummary, PAGE_SIZES, positionFrom } from '@/lib/pagination';
import { apiClient } from '@/lib/trpc';
import { AlertsTable } from './alerts-table';

export const dynamic = 'force-dynamic';

/** The filters a page link carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['status', 'severity'] as const;

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
  const cursor = cursorFrom(params);
  const page = await client.alerts.list.query({
    limit: PAGE_SIZES.alerts,
    ...(statusFilter === undefined ? {} : { status: statusFilter }),
    ...(severityFilter === undefined ? {} : { severity: severityFilter }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const alerts = sortAlerts(page.items);

  const links = pageLinks({
    path: '/alerts',
    params,
    keep: FILTER_PARAMS,
    nextCursor: page.nextCursor,
    shown: alerts.length,
  });
  const position = pageSummary({
    from: positionFrom(params),
    shown: alerts.length,
    total: page.total,
  });
  const footer = <Pagination summary={position} {...links} nextLabel="Show older" />;

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
          {footer}
        </TableCard>
      ) : (
        <AlertsTable alerts={alerts} statusLabels={STATUS_LABELS} now={now} footer={footer} />
      )}
    </div>
  );
}
