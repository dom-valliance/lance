/**
 * View model for the Tasks page (spec 12: "Aggregated across Notion, Jamie,
 * Ian-native. Source badges... Jamie has no completion endpoint; show as
 * read-only with a link."). Mirrors the `tasks.list` contract another
 * engineer is adding to `apps/api` at the same time; the api router is the
 * source of truth once it lands. Kept local for the same reason as
 * `commitment-view.ts`: the web app cannot depend on api-side packages.
 */

import { oneOf, selected, type SearchParams } from '@/lib/filters';
import type { ApiClient } from '@/lib/trpc';

export const TASK_SOURCES = ['notion', 'jamie'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const TASK_STATUSES = ['open', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The status filter options the page offers, in display order. */
export const TASK_STATUS_FILTERS = [...TASK_STATUSES, 'all'] as const;
export type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];

export interface TaskView {
  id: string;
  source: TaskSource;
  sourceId: string;
  title: string;
  status: string;
  done: boolean;
  due: string | null;
  assigneeName: string | null;
  assignedToDom: boolean;
  url: string | null;
  observedAt: string;
  meetingTitle: string | null;
}

const SOURCE_BADGE_LABELS: Record<TaskSource, string> = {
  notion: 'Notion',
  jamie: 'Jamie',
};

/** The source badge text for a task row: "Notion" or "Jamie". */
export function sourceBadgeLabel(source: TaskSource): string {
  return SOURCE_BADGE_LABELS[source];
}

/** The assignee column text: "you" for Dom, the assignee's name, or a
 * plain-words fallback when the source gave none. */
export function assigneeText(view: TaskView): string {
  if (view.assignedToDom) return 'you';
  return view.assigneeName ?? 'unassigned';
}

/** The source filter selected in the query string, "all" when absent. */
export function taskSourceSelected(params: SearchParams): TaskSource | 'all' {
  const raw = selected(params, 'source');
  return raw === '' ? 'all' : (oneOf(TASK_SOURCES, raw) ?? 'all');
}

/** The source the api should filter by; `undefined` means "all". */
export function taskSourceFilterFrom(params: SearchParams): TaskSource | undefined {
  const value = taskSourceSelected(params);
  return value === 'all' ? undefined : value;
}

/** The status filter selected in the query string, "open" when absent. */
export function taskStatusSelected(params: SearchParams): TaskStatusFilter {
  const raw = selected(params, 'status');
  return raw === '' ? 'open' : (oneOf(TASK_STATUS_FILTERS, raw) ?? 'open');
}

/** The status the api should filter by; `undefined` means "all". */
export function taskStatusFilterFrom(params: SearchParams): TaskStatus | undefined {
  const value = taskStatusSelected(params);
  return value === 'all' ? undefined : value;
}

/**
 * The `tasks` router as another engineer is adding it to `apps/api` at the
 * same time as this page (see the tRPC contract in the task brief).
 * `AppRouter` (imported in `@/lib/trpc`) does not carry `tasks` yet, so
 * this narrow contract stands in for it; the api router is the source of
 * truth once it lands, and this interface and the cast in `tasksRouter`
 * are deleted then in favour of calling `client.tasks` directly.
 */
export interface TasksRouterContract {
  list: {
    query(input: {
      source?: TaskSource;
      status?: TaskStatus;
      limit?: number;
      cursor?: string;
    }): Promise<{ items: TaskView[]; nextCursor: string | null }>;
  };
}

/** The one place the stand-in cast above lives. */
export function tasksRouter(client: ApiClient): TasksRouterContract {
  return (client as unknown as { tasks: TasksRouterContract }).tasks;
}
