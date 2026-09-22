/**
 * View model for the Tasks page (spec 12: "Aggregated across Notion, Jamie,
 * Ian-native. Source badges... Jamie has no completion endpoint; show as
 * read-only with a link."). The page reads `client.tasks.list`, whose types
 * are the source of truth; `TaskView` below is the local mirror the pure
 * helpers and their tests take, kept here for the same reason as
 * `commitment-view.ts`: the web app cannot depend on api-side packages.
 */

import { oneOf, selected, type SearchParams } from '@/lib/filters';
import { humanise } from '@/lib/humanise';

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

/** The source's own status beneath a row title: "In progress in Notion". */
export function sourceStatusLine(view: Pick<TaskView, 'source' | 'status'>): string {
  return `${humanise(view.status)} in ${SOURCE_BADGE_LABELS[view.source]}`;
}

/** The little a task needs for the pending-proposal match. */
export interface CompletionTask {
  id: string;
  sourceId: string;
}

/** The little a proposal needs for it: which record it would complete. */
export interface CompletionProposal {
  id: string;
  targetRecordId: string | null;
}

/**
 * The task rows a pending complete-task proposal already covers, as a map
 * from the task's id to that proposal's id, so the Complete column can
 * offer "Proposal pending" rather than a second Mark done. A proposal
 * carries the source's own record id, which is the task's `sourceId`; the
 * first pending proposal for a record wins, so a duplicate does not change
 * where the link goes.
 */
export function pendingCompletionFor(
  tasks: readonly CompletionTask[],
  proposals: readonly CompletionProposal[],
): Map<string, string> {
  const byRecord = new Map<string, string>();
  for (const proposal of proposals) {
    if (proposal.targetRecordId === null) continue;
    if (!byRecord.has(proposal.targetRecordId)) byRecord.set(proposal.targetRecordId, proposal.id);
  }

  const pending = new Map<string, string>();
  for (const task of tasks) {
    const proposalId = byRecord.get(task.sourceId);
    if (proposalId !== undefined) pending.set(task.id, proposalId);
  }
  return pending;
}
