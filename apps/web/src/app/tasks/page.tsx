import { cn } from 'cn';
import { TableCard } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterLinks } from '@/components/filter-links';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
import { type SearchParams } from '@/lib/filters';
import { cursorFrom, pageLinks, PAGE_SIZES, shownLabel } from '@/lib/pagination';
import {
  pendingCompletionFor,
  taskSourceFilterFrom,
  taskSourceSelected,
  taskStatusFilterFrom,
  taskStatusSelected,
  TASK_SOURCES,
  TASK_STATUS_FILTERS,
  type TaskSource,
  type TaskStatusFilter,
} from '@/lib/task-view';
import { apiClient } from '@/lib/trpc';
import { createTask } from './actions';
import { TasksHeader } from './create-task-form';
import { TasksTable } from './tasks-table';

export const dynamic = 'force-dynamic';

/** Enough pending complete-task proposals to match against a page of tasks. */
const PENDING_LIMIT = 200;

/** The filters a page link carries, minus the cursor, so paging restarts on a new filter. */
const FILTER_PARAMS = ['source', 'status'] as const;

const SOURCE_LABELS: Record<TaskSource | 'all', string> = {
  all: 'All',
  notion: 'Notion',
  jamie: 'Jamie',
};

const STATUS_LABELS: Record<TaskStatusFilter, string> = {
  open: 'Open',
  done: 'Done',
  all: 'All',
};

/** Pills scroll sideways at 360 rather than wrapping on to a second line. */
const PILL_ROW = 'flex-nowrap overflow-x-auto [&>span]:shrink-0 [&>div]:flex-nowrap';

/** A link for this page that keeps every current filter except the one being changed. */
function filterHref(
  current: { source: TaskSource | 'all'; status: TaskStatusFilter },
  change: Partial<{ source: TaskSource | 'all'; status: TaskStatusFilter }>,
): string {
  const next = { ...current, ...change };
  const query = new URLSearchParams();
  if (next.source !== 'all') query.set('source', next.source);
  if (next.status !== 'open') query.set('status', next.status);
  const search = query.toString();
  return search === '' ? '/tasks' : `/tasks?${search}`;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const source = taskSourceSelected(params);
  const status = taskStatusSelected(params);
  const current = { source, status };
  const now = new Date();

  const client = await apiClient();
  const sourceFilter = taskSourceFilterFrom(params);
  const statusFilter = taskStatusFilterFrom(params);
  const cursor = cursorFrom(params);
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`). The two reads batch into one request over the
  // tRPC link.
  const [page, proposals] = await Promise.all([
    client.tasks.list.query({
      limit: PAGE_SIZES.tasks,
      ...(sourceFilter === undefined ? {} : { source: sourceFilter }),
      ...(statusFilter === undefined ? {} : { status: statusFilter }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    client.proposals.list.query({
      status: 'pending',
      actionClass: 'complete_task',
      limit: PENDING_LIMIT,
    }),
  ]);
  const tasks = page.items;
  const pending = pendingCompletionFor(tasks, proposals.items);

  const count = status === 'open' ? tasks.filter((task) => !task.done).length : tasks.length;
  const summary = `${String(count)} ${status === 'open' ? 'open' : 'shown'}. Jamie tasks are completed in Jamie; Lance can only read them.`;

  const links = pageLinks({
    path: '/tasks',
    params,
    keep: FILTER_PARAMS,
    nextCursor: page.nextCursor,
  });
  const footer = (
    <Pagination summary={shownLabel(tasks.length)} {...links} nextLabel="Show older" />
  );

  return (
    <div className="flex flex-col gap-6">
      <TasksHeader summary={summary} action={createTask} />

      <div className="flex flex-col gap-3">
        <FilterLinks
          label="Source"
          options={(['all', ...TASK_SOURCES] as const).map((value) => ({
            label: SOURCE_LABELS[value],
            href: filterHref(current, { source: value }),
            active: source === value,
          }))}
          className={PILL_ROW}
        />
        <FilterLinks
          label="Status"
          options={TASK_STATUS_FILTERS.map((value) => ({
            label: STATUS_LABELS[value],
            href: filterHref(current, { status: value }),
            active: status === value,
          }))}
          className={cn(PILL_ROW, 'border-t border-border pt-3 lg:border-t-0 lg:pt-0')}
        />
      </div>

      {tasks.length === 0 ? (
        <TableCard>
          <EmptyState>
            No tasks match these filters. <TextLink href="/tasks">Clear them</TextLink> to see every
            open task.
          </EmptyState>
          {footer}
        </TableCard>
      ) : (
        <TasksTable tasks={tasks} pending={pending} now={now} footer={footer} />
      )}

      <p className="text-xs text-muted-foreground">
        Mark done creates a complete-task proposal; the task changes in Notion only after you
        approve it. Deduplicated across Notion and Jamie by title and meeting.
      </p>
    </div>
  );
}
