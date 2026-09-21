import type { CallContext } from '../core/connector.js';
import { ConnectorError } from '../core/errors.js';
import { notionSendAccess, type NotionConnector } from './client.js';
import {
  fromNotionDataSource,
  fromNotionPage,
  fromNotionUser,
  notionDataSourceSchema,
  notionPageSchema,
  notionQueryResponseSchema,
  notionUserListSchema,
  notionUserSchema,
  type DataSourceSchema,
  type NotionUserSummary,
  type TaskRecord,
} from './types.js';

/** Notion's maximum, and the watcher's window size. */
export const QUERY_PAGE_SIZE = 100;

/**
 * The ceiling on a paged Notion read, as Graph's delta reads have. At 100
 * rows a page this is 20,000 rows, far more than the All Tasks database or
 * the workspace member list holds; reaching it means Notion is paging
 * without converging, and the read fails loudly rather than spinning.
 */
export const MAX_QUERY_PAGES = 200;

function pagingDidNotFinish(operation: string, advice: string): ConnectorError {
  return new ConnectorError(
    `notion ${operation}: paging did not finish within ${MAX_QUERY_PAGES} pages of ${QUERY_PAGE_SIZE}. ${advice}`,
    { connector: 'notion', operation, retryable: false },
  );
}

export interface QueryTasksArgs {
  /**
   * The All Tasks data source. Config holds it (`notion.tasksDataSourceId`);
   * the connector takes no configuration of its own.
   */
  dataSourceId: string;
  /** ISO 8601 instant. Only pages edited strictly after it are returned. */
  since: string;
  /** Resumes a run from a cursor the previous run returned. */
  cursor?: string;
}

export interface QueryTasksResult {
  readonly tasks: readonly TaskRecord[];
  /** The last `next_cursor` Notion sent; `null` once the window is exhausted. */
  readonly cursor: string | null;
}

interface QueryPageResult {
  readonly tasks: readonly TaskRecord[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

async function queryOnePage(
  notion: NotionConnector,
  args: QueryTasksArgs,
  cursor: string | null,
  context: CallContext,
): Promise<QueryPageResult> {
  const body = {
    filter: { timestamp: 'last_edited_time', last_edited_time: { after: args.since } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    page_size: QUERY_PAGE_SIZE,
    ...(cursor === null ? {} : { start_cursor: cursor }),
  };
  const raw = await notion.connector.read(
    'queryTasksEditedSince',
    { ...context, request: { dataSourceId: args.dataSourceId, since: args.since, cursor } },
    () =>
      notionSendAccess(notion)(
        'queryTasksEditedSince',
        `/data_sources/${args.dataSourceId}/query`,
        { method: 'POST', body },
      ),
  );
  const response = notionQueryResponseSchema.parse(raw);
  return {
    tasks: response.results.map(fromNotionPage),
    nextCursor: response.next_cursor,
    hasMore: response.has_more,
  };
}

/**
 * Every task edited after `since`, oldest edit first, following `next_cursor`
 * to the end of the window. Each page is its own rate-limited call.
 */
export async function queryTasksEditedSince(
  notion: NotionConnector,
  args: QueryTasksArgs,
  context: CallContext = {},
): Promise<QueryTasksResult> {
  const tasks: TaskRecord[] = [];
  let cursor: string | null = args.cursor ?? null;
  for (let page = 1; page <= MAX_QUERY_PAGES; page += 1) {
    const result: QueryPageResult = await queryOnePage(notion, args, cursor, context);
    tasks.push(...result.tasks);
    cursor = result.nextCursor;
    if (!result.hasMore || cursor === null) return { tasks, cursor };
  }
  throw pagingDidNotFinish(
    'queryTasksEditedSince',
    'Narrow the window by moving the watcher cursor forward, then resume from the cursor the last run returned.',
  );
}

/** One task page, normalised. */
export async function getTask(
  notion: NotionConnector,
  pageId: string,
  context: CallContext = {},
): Promise<TaskRecord> {
  const raw = await notion.connector.read('getTask', { ...context, request: { pageId } }, () =>
    notion.send('getTask', `/pages/${pageId}`),
  );
  return fromNotionPage(notionPageSchema.parse(raw));
}

/**
 * The data source's property names and types, so the watcher can assert the
 * permitted-property list in config still matches the database (ADR 0009).
 */
export async function getDataSourceSchema(
  notion: NotionConnector,
  dataSourceId: string,
  context: CallContext = {},
): Promise<DataSourceSchema> {
  const raw = await notion.connector.read(
    'getDataSourceSchema',
    { ...context, request: { dataSourceId } },
    () => notion.send('getDataSourceSchema', `/data_sources/${dataSourceId}`),
  );
  return fromNotionDataSource(notionDataSourceSchema.parse(raw));
}

/** Every workspace member, for resolving a delegate's name to a Notion user. */
export async function listUsers(
  notion: NotionConnector,
  context: CallContext = {},
): Promise<readonly NotionUserSummary[]> {
  const users: NotionUserSummary[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_QUERY_PAGES; page += 1) {
    const query: Record<string, string> = { page_size: String(QUERY_PAGE_SIZE) };
    if (cursor !== null) query.start_cursor = cursor;
    const raw = await notion.connector.read('listUsers', { ...context, request: { cursor } }, () =>
      notion.send('listUsers', '/users', { query }),
    );
    const response = notionUserListSchema.parse(raw);
    users.push(...response.results.map(fromNotionUser));
    cursor = response.next_cursor;
    if (!response.has_more || cursor === null) return users;
  }
  throw pagingDidNotFinish(
    'listUsers',
    'Check the Notion workspace member count and the integration permissions before retrying.',
  );
}

/** One workspace member by id. */
export async function getUser(
  notion: NotionConnector,
  userId: string,
  context: CallContext = {},
): Promise<NotionUserSummary> {
  const raw = await notion.connector.read('getUser', { ...context, request: { userId } }, () =>
    notion.send('getUser', `/users/${userId}`),
  );
  return fromNotionUser(notionUserSchema.parse(raw));
}
