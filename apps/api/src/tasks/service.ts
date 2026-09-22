import type { ApiDeps } from '../deps.js';
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
}

export async function listTasks(deps: TaskDeps, input: ListTasksInput): Promise<TaskPage> {
  const size = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  // One row beyond the page tells us whether a next page exists without a count.
  const rows = await deps.tasks.list({
    limit: size + 1,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return {
    items: toTaskViews(page, { domNotionUserId: deps.config.notion.domUserId }),
    nextCursor,
  };
}
