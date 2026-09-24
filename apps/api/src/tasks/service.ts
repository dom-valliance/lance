import type { ApiDeps } from '../deps.js';
import type { TaskCountQuery } from './store.js';
import { toTaskViews, type TaskSource, type TaskView } from './view.js';

/**
 * The Tasks page's one read (spec 12, Tasks row). Notion and Jamie rows are
 * aggregated out of the ledger's observations; neither source is called.
 */

export type TaskDeps = Pick<ApiDeps, 'tasks' | 'config'>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ListTasksInput {
  source?: TaskSource | undefined;
  status?: 'open' | 'done' | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface TaskPage {
  items: TaskView[];
  nextCursor: string | null;
  /** Every task the filters match, across all pages. */
  total: number;
}

export async function listTasks(deps: TaskDeps, input: ListTasksInput): Promise<TaskPage> {
  const size = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const filter: TaskCountQuery = {
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
  // One row beyond the page tells us whether a next page exists; the count
  // runs beside it over the same filters, without the cursor.
  const [rows, total, principalNotionUserId] = await Promise.all([
    deps.tasks.list({
      ...filter,
      limit: size + 1,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    deps.tasks.count(filter),
    deps.tasks.principalNotionUserId(),
  ]);
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return {
    items: toTaskViews(page, { principalNotionUserId }),
    nextCursor,
    total,
  };
}
