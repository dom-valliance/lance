/**
 * The Jamie connector: reads and types. There is no writes module and no
 * entry in `@lance/connectors/writes`, because Jamie is read-only in v1
 * (ADR 0005, CLAUDE.md non-negotiable 3). `meetings.delete` and
 * `tasks.update` exist on the API and are never wrapped.
 */
export {
  createJamieConnector,
  jamieProcedurePath,
  jamiePolicy,
  JAMIE_HEALTH_PATH,
  JAMIE_KEY_ADVICE,
  JAMIE_PERSONAL_ROUTE_PREFIX,
} from './client.js';
export type { JamieConnector, JamieConnectorOptions, JamieReadRequest } from './client.js';

export {
  checkAccess,
  createJamieReads,
  getMeeting,
  listAllMeetings,
  listAllTasks,
  listMeetings,
  listTags,
  listTasks,
  searchMeetings,
  MAX_LIST_PAGES,
  MAX_PAGE_LIMIT,
} from './reads.js';
export type { JamieAccess, ListAllOptions } from './reads.js';

export {
  jamieAttendeeSchema,
  jamieMeetingListSchema,
  jamieMeetingSchema,
  jamieMeetingSummarySchema,
  jamieMeetingTaskSchema,
  jamieParticipantSchema,
  jamieSearchResponseSchema,
  jamieSearchResultSchema,
  jamieTagListSchema,
  jamieTagRefSchema,
  jamieTagSchema,
  jamieTaskListSchema,
  jamieTaskSchema,
  JAMIE_API_BASE_URL,
} from './types.js';
export type {
  JamieMeeting,
  JamieMeetingSummary,
  JamieReads,
  JamieSearchResult,
  JamieTag,
  JamieTask,
  ListMeetingsArgs,
  ListTasksArgs,
  SearchMeetingsArgs,
} from './types.js';
