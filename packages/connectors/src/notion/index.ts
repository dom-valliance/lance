/**
 * The Notion connector's reads and types. Writes are deliberately absent:
 * they reach the executor only through `@lance/connectors/writes`, which the
 * ESLint import boundary guards (CLAUDE.md non-negotiable 2).
 */
export {
  createNotionConnector,
  notionPageUrl,
  notionPolicy,
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
} from './client.js';
export type {
  NotionConnector,
  NotionConnectorOptions,
  NotionReadRequest,
  NotionRequest,
} from './client.js';

export {
  getDataSourceSchema,
  getPageText,
  getTask,
  getUser,
  listUsers,
  MAX_QUERY_PAGES,
  PAGE_TEXT_MAX_BLOCKS,
  queryMeetingsEditedSince,
  queryTasksEditedSince,
  QUERY_PAGE_SIZE,
} from './reads.js';
export type {
  GetPageTextOptions,
  QueryMeetingsArgs,
  QueryMeetingsResult,
  QueryTasksArgs,
  QueryTasksResult,
} from './reads.js';

export {
  blockPlainText,
  fromNotionDataSource,
  fromNotionMeetingPage,
  fromNotionPage,
  fromNotionUser,
  MEETING_PROPERTY_NAMES,
  notionBlockListSchema,
  notionBlockSchema,
  notionDataSourceSchema,
  notionMeetingPageSchema,
  notionMeetingQueryResponseSchema,
  notionPageSchema,
  notionQueryResponseSchema,
  notionUserSchema,
  TASK_PRIORITIES,
  TASK_PROPERTY_NAMES,
  TASK_STATUSES,
  TASK_SUB_TYPES,
  TEXT_BLOCK_TYPES,
} from './types.js';
export type {
  DataSourceProperty,
  DataSourceSchema,
  MeetingRecord,
  NotionBlock,
  NotionMeetingPage,
  NotionPage,
  NotionUserSummary,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  TaskSubType,
} from './types.js';
