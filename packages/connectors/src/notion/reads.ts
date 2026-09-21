import type { CallContext } from '../core/connector.js';
import type { NotionConnector } from './client.js';
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
      notion.send('queryTasksEditedSince', `/data_sources/${args.dataSourceId}/query`, {
        method: 'POST',
        body,
      }),
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
  for (;;) {
    const page: QueryPageResult = await queryOnePage(notion, args, cursor, context);
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
    if (!page.hasMore || cursor === null) break;
  }
  return { tasks, cursor };
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
  for (;;) {
    const query: Record<string, string> = { page_size: String(QUERY_PAGE_SIZE) };
    if (cursor !== null) query.start_cursor = cursor;
    const raw = await notion.connector.read('listUsers', { ...context, request: { cursor } }, () =>
      notion.send('listUsers', '/users', { query }),
    );
    const response = notionUserListSchema.parse(raw);
    users.push(...response.results.map(fromNotionUser));
    cursor = response.next_cursor;
    if (!response.has_more || cursor === null) break;
  }
  return users;
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
