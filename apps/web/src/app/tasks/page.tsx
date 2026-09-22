import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FilterLinks } from '@/components/filter-links';
import { type SearchParams } from '@/lib/filters';
import { formatInstant } from '@/lib/proposal-view';
import {
  assigneeText,
  sourceBadgeLabel,
  tasksRouter,
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

export const dynamic = 'force-dynamic';

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

  const client = await apiClient();
  const sourceFilter = taskSourceFilterFrom(params);
  const statusFilter = taskStatusFilterFrom(params);
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`).
  const result = await tasksRouter(client).list.query({
    limit: 100,
    ...(sourceFilter === undefined ? {} : { source: sourceFilter }),
    ...(statusFilter === undefined ? {} : { status: statusFilter }),
  });
  const tasks = result.items;

  // The spec's "Create task" and "Complete" buttons (spec 12) arrive once
  // create-task and complete-task proposals exist; this page is read-only
  // for every source in the meantime.

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Jamie tasks cannot be completed here; use the link on each Jamie row to open it in
            Jamie.
          </p>
          <FilterLinks
            label="Source"
            options={(['all', ...TASK_SOURCES] as const).map((value) => ({
              label: SOURCE_LABELS[value],
              href: filterHref(current, { source: value }),
              active: source === value,
            }))}
          />
          <FilterLinks
            label="Status"
            options={TASK_STATUS_FILTERS.map((value) => ({
              label: STATUS_LABELS[value],
              href: filterHref(current, { status: value }),
              active: status === value,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tasks match these filters. Clear them to see the whole list.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Tasks aggregated across sources</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Title
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Source
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Due
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Assignee
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Meeting
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Link
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={`${task.source}:${task.id}`} className="border-t border-border">
                    <td className="py-2 pr-4">
                      <p>{task.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{task.status}</p>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline">{sourceBadgeLabel(task.source)}</Badge>
                    </td>
                    <td className="py-2 pr-4">
                      {task.due === null ? 'No date' : formatInstant(task.due)}
                    </td>
                    <td className="py-2 pr-4">{assigneeText(task)}</td>
                    <td className="py-2 pr-4">
                      {task.meetingTitle ?? <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="py-2">
                      {task.url === null ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <a
                          href={task.url}
                          className="text-xs underline underline-offset-4 hover:text-primary"
                          rel="noreferrer"
                        >
                          Open in {sourceBadgeLabel(task.source)}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
