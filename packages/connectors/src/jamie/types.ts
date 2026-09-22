import { z } from 'zod';

/**
 * Jamie's public REST API (ADR 0005), as observed against
 * https://beta-api.meetjamie.ai on 2026-09-21 and documented at
 * https://docs.meetjamie.ai/developers/api. The API is tRPC over HTTP: a
 * GET carries its input as `?input={"json":{...}}` and every reply is
 * wrapped as `{ result: { data: { json: ... } } }`; an error reply is
 * `{ error: { json: { message, code, data: { httpStatus } } } }`.
 *
 * Personal keys (`jk_`) use the `/v1/me/` routes. Lance uses only the
 * reads below. `meetings.delete` and `tasks.update` exist and are never
 * wrapped (non-negotiable 3; ADR 0005).
 */

export const JAMIE_API_BASE_URL = 'https://beta-api.meetjamie.ai';

export const jamieIdSchema = z.string().min(1);

/** One row of `meetings.list`. `generatedTitle` is present when Jamie named the meeting. */
export const jamieMeetingSummarySchema = z.looseObject({
  id: jamieIdSchema,
  title: z.string().nullable(),
  generatedTitle: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  calendarEventId: z.string().nullable(),
  userId: z.string(),
  isShared: z.boolean(),
});

export const jamieMeetingListSchema = z.looseObject({
  meetings: z.array(jamieMeetingSummarySchema),
  /** `<startTime ISO>::<meeting id>`, opaque to Lance. */
  nextCursor: z.string().nullable(),
});

export const jamieParticipantSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  email: z.string().nullish(),
});

export const jamieAttendeeSchema = z.looseObject({
  name: z.string().nullish(),
  email: z.string().nullish(),
  responseStatus: z.string().nullish(),
  organizer: z.boolean().nullish(),
});

export const jamieMeetingTaskSchema = z.looseObject({
  /** `meetings.get` calls it `content`; `tasks.list` calls it `text`. */
  content: z.string().nullish(),
  text: z.string().nullish(),
  completed: z.boolean(),
  assignee: z
    .looseObject({
      id: z.string().nullish(),
      name: z.string().nullish(),
      email: z.string().nullish(),
    })
    .nullish(),
});

export const jamieTagRefSchema = z.looseObject({ name: z.string(), color: z.string().nullish() });

/** The full `meetings.get` object. Transcript is markdown with bold speaker names; empty until processed. */
export const jamieMeetingSchema = z.looseObject({
  id: jamieIdSchema,
  title: z.string().nullable(),
  generatedTitle: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  locked: z.boolean().nullish(),
  user: z.looseObject({ id: z.string(), email: z.string().nullish() }).nullish(),
  summary: z
    .looseObject({
      markdown: z.string().nullish(),
      html: z.string().nullish(),
      short: z.string().nullish(),
    })
    .nullish(),
  transcript: z.string().nullish(),
  scratchpadNotes: z.string().nullish(),
  participants: z.array(jamieParticipantSchema).default([]),
  tasks: z.array(jamieMeetingTaskSchema).default([]),
  tags: z.array(jamieTagRefSchema).default([]),
  event: z
    .looseObject({
      id: z.string().nullish(),
      /** The calendar system's own id, a Graph event id for Dom's mailbox. */
      externalId: z.string().nullish(),
      title: z.string().nullish(),
      scheduledTime: z.string().nullish(),
      endTime: z.string().nullish(),
      attendees: z.array(jamieAttendeeSchema).default([]),
    })
    .nullish(),
});

export const jamieTaskSchema = z.looseObject({
  id: jamieIdSchema,
  text: z.string(),
  completed: z.boolean(),
  assignee: z
    .looseObject({
      id: z.string().nullish(),
      name: z.string().nullish(),
      email: z.string().nullish(),
    })
    .nullable(),
  meetingId: z.string().nullable(),
  meetingTitle: z.string().nullable(),
  createdAt: z.string(),
  userId: z.string(),
});

export const jamieTaskListSchema = z.looseObject({
  tasks: z.array(jamieTaskSchema),
  nextCursor: z.string().nullable(),
});

export const jamieTagSchema = z.looseObject({
  id: jamieIdSchema,
  name: z.string(),
  shared: z.boolean().nullish(),
});

export const jamieTagListSchema = z.looseObject({ tags: z.array(jamieTagSchema) });

export const jamieSearchResultSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  meetingId: z.string(),
  meetingTitle: z.string().nullable(),
  meetingDate: z.string(),
});

export const jamieSearchResponseSchema = z.looseObject({
  results: z.array(jamieSearchResultSchema),
});

export type JamieMeetingSummary = z.infer<typeof jamieMeetingSummarySchema>;
export type JamieMeeting = z.infer<typeof jamieMeetingSchema>;
export type JamieTask = z.infer<typeof jamieTaskSchema>;
export type JamieTag = z.infer<typeof jamieTagSchema>;
export type JamieSearchResult = z.infer<typeof jamieSearchResultSchema>;

export interface ListMeetingsArgs {
  /** ISO 8601; meetings on or after this instant. */
  startDate?: string;
  endDate?: string;
  /** From a previous page's `nextCursor`. */
  cursor?: string;
  /** 1 to 100, default 50. */
  limit?: number;
  /** Personal keys only: a tag name. */
  tag?: string;
}

export interface ListTasksArgs {
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
  completed?: boolean;
  meetingId?: string;
}

export interface SearchMeetingsArgs {
  query: string;
  startDate?: string;
  endDate?: string;
}

/**
 * The read surface the Jamie watcher and the agents' read tools consume.
 * `apps/worker` codes against this interface; `reads.ts` implements it.
 */
export interface JamieReads {
  /** One page of meetings, newest first. */
  listMeetings(args?: ListMeetingsArgs): Promise<z.infer<typeof jamieMeetingListSchema>>;
  /** The full meeting with summary, transcript, participants, tasks, tags and calendar event. */
  getMeeting(meetingId: string): Promise<JamieMeeting>;
  /** Semantic search over transcript chunks, last six months by default. */
  searchMeetings(args: SearchMeetingsArgs): Promise<JamieSearchResult[]>;
  /** One page of action items, newest first. */
  listTasks(args?: ListTasksArgs): Promise<z.infer<typeof jamieTaskListSchema>>;
  listTags(): Promise<JamieTag[]>;
}
