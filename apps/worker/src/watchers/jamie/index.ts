/**
 * The `jamie` watcher (spec 7.1), read-only per ADR 0005. Registration
 * lives in `main.ts`.
 */

export {
  JAMIE_PARTITIONS,
  JAMIE_SCHEDULES,
  JAMIE_WATCHER_NAME,
  createJamieWatcher,
} from './watcher.js';
export type { JamieWatcherOptions } from './watcher.js';

export { MEETINGS_PARTITION, jamieMeetingUrl, normaliseMeeting, pollMeetings } from './meetings.js';
export type {
  JamieMeetingActionItem,
  JamieMeetingAttendee,
  JamieMeetingParticipant,
  JamieMeetingRecord,
} from './meetings.js';

export { TASKS_PARTITION, normaliseTask, pollTasks } from './tasks.js';
export type { JamieTaskRecord } from './tasks.js';

export {
  JAMIE_FIRST_RUN_DAYS,
  JAMIE_MAX_PAGES,
  JAMIE_OVERLAP_HOURS,
  collectPages,
  newestInstant,
  sameEmail,
  windowStart,
} from './paging.js';
export type { JamiePage } from './paging.js';
