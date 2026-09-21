/**
 * The two Microsoft Graph watchers (spec 7.1) and the Haiku labeller
 * `graph-mail` calls once per message. Registration lives in `main.ts`.
 */

export {
  DEFAULT_MAIL_FOLDERS,
  GRAPH_MAIL_SCHEDULES,
  GRAPH_MAIL_WATCHER_NAME,
  MAIL_FOLDER_KINDS,
  MAX_BODY_CHARS,
  UNLABELLED,
  bodyTextOf,
  createGraphMailWatcher,
  htmlToText,
  resolveMailFolders,
} from './mail.js';
export type {
  GraphMailRecord,
  GraphMailWatcherOptions,
  MailAddress,
  MailFolderKind,
  MailFolderSpec,
  MailLabeller,
} from './mail.js';

export {
  MAIL_LABEL_AGENT_NAME,
  MAIL_LABEL_AGENT_VERSION,
  MAX_LABEL_BODY_CHARS,
  MailLabelOutputSchema,
  RISK_LABEL,
  createHaikuLabeller,
  labelsFrom,
  mailLabelSystemPrompt,
  mailLabelUserPrompt,
} from './label.js';
export type { HaikuLabellerOptions, MailLabelOutput } from './label.js';

export {
  CALENDAR_PARTITION,
  CALENDAR_WINDOW_DAYS,
  GRAPH_CALENDAR_SCHEDULES,
  GRAPH_CALENDAR_WATCHER_NAME,
  INTERNAL_DOMAIN,
  createGraphCalendarWatcher,
  externalAttendees,
  findConflicts,
  graphInstant,
} from './calendar.js';
export type {
  CalendarAttendee,
  CalendarMoment,
  CalendarPerson,
  EventConflict,
  GraphCalendarRecord,
  GraphCalendarWatcherOptions,
} from './calendar.js';
