/**
 * View model for the Alerts page (spec 11 and 12: "Open, acked, muted.
 * Ack, mute, link to provenance."). `client.alerts.*` is already on
 * `AppRouter` (`apps/api/src/router.ts`), so the page's `AlertView` comes
 * straight from the tRPC client's inferred return type; nothing here
 * duplicates that shape. What lives here is pure: the filters the page
 * reads from the URL, the sort spec 12 asks for, and which of the three
 * actions a row's current status still allows.
 */

import { oneOf, selected, type SearchParams } from '@/lib/filters';

export const ALERT_STATUSES = ['open', 'acked', 'resolved', 'suppressed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** The status filter options the page offers, in display order. Open is the default. */
export const ALERT_STATUS_FILTERS = [...ALERT_STATUSES, 'all'] as const;
export type AlertStatusFilter = (typeof ALERT_STATUS_FILTERS)[number];

export const ALERT_SEVERITIES = ['P0', 'P1', 'P2'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_SEVERITY_FILTERS = [...ALERT_SEVERITIES, 'all'] as const;
export type AlertSeverityFilter = (typeof ALERT_SEVERITY_FILTERS)[number];

/** The status filter selected in the query string, `open` when absent. */
export function alertStatusSelected(params: SearchParams): AlertStatusFilter {
  const raw = selected(params, 'status');
  return raw === '' ? 'open' : (oneOf(ALERT_STATUS_FILTERS, raw) ?? 'open');
}

/** The status the api should filter by; `undefined` means "all". */
export function alertStatusFilterFrom(params: SearchParams): AlertStatus | undefined {
  const value = alertStatusSelected(params);
  return value === 'all' ? undefined : value;
}

/** The severity filter selected in the query string, `all` when absent. */
export function alertSeveritySelected(params: SearchParams): AlertSeverityFilter {
  const raw = selected(params, 'severity');
  return raw === '' ? 'all' : (oneOf(ALERT_SEVERITY_FILTERS, raw) ?? 'all');
}

/** The severity the api should filter by; `undefined` means "all". */
export function alertSeverityFilterFrom(params: SearchParams): AlertSeverity | undefined {
  const value = alertSeveritySelected(params);
  return value === 'all' ? undefined : value;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { P0: 0, P1: 1, P2: 2 };

/**
 * Sort order for the alerts table (spec 12): P0 first, then P1, then P2;
 * within a severity, most recently seen first.
 */
export type SortableAlert = { severity: AlertSeverity; lastSeen: string };

export function alertSort(a: SortableAlert, b: SortableAlert): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rank !== 0) return rank;
  return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
}

/** Sorts a copy of `views`; the source array is left untouched. */
export function sortAlerts<T extends SortableAlert>(views: readonly T[]): T[] {
  return [...views].sort(alertSort);
}

/** Ack only makes sense while the alert is still open (`apps/api/src/alerts/service.ts`). */
export function canAck(view: { status: AlertStatus }): boolean {
  return view.status === 'open';
}

/** Mute is offered from open or acked; the api also lets an already-muted alert extend itself. */
export function canMute(view: { status: AlertStatus }): boolean {
  return view.status === 'open' || view.status === 'acked';
}

/** Resolve is offered from open or acked, mirroring the api's `RESOLVABLE_FROM`. */
export function canResolve(view: { status: AlertStatus }): boolean {
  return view.status === 'open' || view.status === 'acked';
}

/** The fixed mute window the page's "Mute 24h" button asks for. */
export const MUTE_HOURS = 24;
