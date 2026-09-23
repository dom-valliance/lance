import {
  CalendarEventSchema,
  type Attendee,
  type CalendarEvent,
  type DateTimeTimeZone,
  type GraphReads,
  type Recipient,
} from '@lance/connectors/graph';
import { nowIso, toLondon } from '@lance/shared';
import type { Observation, PollResult, SourceRecord, Watcher } from '../types.js';

/**
 * The `graph-calendar` watcher (spec 7.1): the next fourteen days by delta,
 * every fifteen minutes. New, moved and cancelled events and attendee
 * changes all reach the ledger as fresh observations, because each of them
 * changes the canonical record and therefore its hash.
 *
 * `findConflicts` and `externalAttendees` are the detection helpers behind
 * the `calendar_conflict` and `external_meeting_unknown_attendee` alerts
 * (spec 11). They are pure; raising the alerts is wired separately.
 */

export const GRAPH_CALENDAR_WATCHER_NAME = 'graph-calendar';

/** Spec 7.1: every 15 minutes, at every hour of every day. */
export const GRAPH_CALENDAR_SCHEDULES = ['*/15 * * * *'] as const;

/** One calendar, so one partition. Named rather than empty so the cursor row reads clearly. */
export const CALENDAR_PARTITION = 'calendar';

/** Spec 7.1: "Next 14 days". */
export const CALENDAR_WINDOW_DAYS = 14;

/** Spec 11 `external_meeting_unknown_attendee`: anyone off this domain is external. */
export const INTERNAL_DOMAIN = 'valliance.ai';

const MAX_SUMMARY_CHARS = 200;

export interface CalendarPerson {
  name: string | null;
  address: string | null;
}

export interface CalendarAttendee extends CalendarPerson {
  /** `required`, `optional` or `resource`. */
  type: string | null;
  /** `none`, `accepted`, `declined`, `tentativelyAccepted` or `organizer`. */
  responseStatus: string | null;
}

/** When and where, kept exactly as Graph sent it: the wall clock and its zone. */
export interface CalendarMoment {
  dateTime: string;
  timeZone: string | null;
}

/**
 * The canonical calendar record. Its hash is the third part of the
 * idempotency key, so a move, a cancellation or an attendee response
 * produces a new observation on the next poll without any diffing here.
 */
export type GraphCalendarRecord = {
  id: string;
  iCalUId: string | null;
  subject: string | null;
  start: CalendarMoment | null;
  end: CalendarMoment | null;
  isAllDay: boolean | null;
  isCancelled: boolean | null;
  organizer: CalendarPerson | null;
  attendees: CalendarAttendee[];
  location: string | null;
  joinUrl: string | null;
  webLink: string | null;
  lastModifiedDateTime: string | null;
  removed: boolean;
};

export interface GraphCalendarWatcherOptions {
  reads: Pick<GraphReads, 'deltaCalendarView' | 'getEvent'>;
  now?: () => string;
  schedules?: readonly string[];
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    // Constructed only to trigger its RangeError on an unknown zone name.
    void new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** How far the named zone's wall clock is ahead of UTC at `instantMs`. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
  const wallClock = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wallClock - instantMs;
}

/**
 * Graph sends a calendar time as a wall clock plus a zone name, never an
 * offset. This turns the pair into a UTC instant. Lance asks Graph for no
 * particular zone, so the answer is UTC in practice; an IANA zone name is
 * resolved properly, and a Windows zone name (`GMT Standard Time` and its
 * kind), which `Intl` cannot read, is treated as UTC.
 */
export function graphInstant(value: DateTimeTimeZone | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const dateTime = value.dateTime.trim();
  if (dateTime === '') return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime);
  const asUtc = Date.parse(hasOffset ? dateTime : `${dateTime}Z`);
  if (Number.isNaN(asUtc)) return null;

  const timeZone = value.timeZone ?? 'UTC';
  if (hasOffset || timeZone.toUpperCase() === 'UTC' || !isValidTimeZone(timeZone)) {
    return new Date(asUtc).toISOString();
  }
  // Two passes: the first offset is read at the wrong instant when the wall
  // clock sits near a daylight-saving change, the second at the right one.
  const firstPass = asUtc - zoneOffsetMs(asUtc, timeZone);
  return new Date(asUtc - zoneOffsetMs(firstPass, timeZone)).toISOString();
}

function personOf(value: Recipient | null | undefined): CalendarPerson | null {
  const emailAddress = value?.emailAddress;
  if (emailAddress === null || emailAddress === undefined) return null;
  return { name: emailAddress.name ?? null, address: emailAddress.address ?? null };
}

function attendeesOf(attendees: Attendee[] | null | undefined): CalendarAttendee[] {
  return (attendees ?? []).map((attendee) => ({
    name: attendee.emailAddress?.name ?? null,
    address: attendee.emailAddress?.address ?? null,
    type: attendee.type ?? null,
    responseStatus: attendee.status?.response ?? null,
  }));
}

function momentOf(value: DateTimeTimeZone | null | undefined): CalendarMoment | null {
  if (value === null || value === undefined) return null;
  return { dateTime: value.dateTime, timeZone: value.timeZone ?? null };
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function parseEvent(raw: unknown): CalendarEvent {
  const parsed = CalendarEventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(
    `graph-calendar could not read an event: ${parsed.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ')}. Update CalendarEventSchema in packages/connectors/src/graph/types.ts.`,
  );
}

/** Adds whole days to an ISO instant. Calendar windows are day-sized, never month-sized. */
function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The calendar delta returns an occurrence of a recurring series in a
 * cut-down form: id, start and end, with nothing else. Every full event
 * carries `subject`, `organizer` and `attendees` (null or empty when
 * blank), so all three missing at once marks the cut-down form. Stored as
 * it arrives it would reach the brief as "(no subject)" with nobody in it.
 */
export function isAbbreviatedOccurrence(event: CalendarEvent): boolean {
  return (
    event.subject === undefined &&
    event.organizer === undefined &&
    event.attendees === undefined &&
    event.start !== undefined &&
    event.start !== null
  );
}

export function createGraphCalendarWatcher(options: GraphCalendarWatcherOptions): Watcher {
  const now = options.now ?? nowIso;

  /** Reads an abbreviated occurrence in full; anything else passes through. */
  const hydrate = (event: CalendarEvent): Promise<CalendarEvent> =>
    isAbbreviatedOccurrence(event) ? options.reads.getEvent(event.id) : Promise.resolve(event);

  return {
    name: GRAPH_CALENDAR_WATCHER_NAME,
    sourceSystem: 'graph',
    schedules: [...(options.schedules ?? GRAPH_CALENDAR_SCHEDULES)],

    partitions: () => Promise.resolve([CALENDAR_PARTITION]),

    async poll(_partition: string, cursor: string | null): Promise<PollResult> {
      const start = now();
      const delta = await options.reads.deltaCalendarView({
        start,
        end: addDays(start, CALENDAR_WINDOW_DAYS),
        ...(cursor === null ? {} : { deltaLink: cursor }),
      });
      // A hydration failure fails the poll, and the cursor stays where it
      // was, so the next poll asks for the same occurrences again.
      const events = await Promise.all(delta.events.map(hydrate));
      const records: SourceRecord[] = events.map((event) => ({
        id: event.id,
        observedAt: event.lastModifiedDateTime ?? start,
        raw: event,
      }));
      for (const id of delta.removed) {
        records.push({ id, observedAt: start, raw: { id }, removed: true });
      }
      return { records, nextCursor: delta.deltaLink };
    },

    normalise(record: SourceRecord): Promise<Observation> {
      const event = parseEvent(record.raw);
      const removed = record.removed === true;
      const canonical: GraphCalendarRecord = {
        id: event.id,
        iCalUId: event.iCalUId ?? null,
        subject: event.subject ?? null,
        start: momentOf(event.start),
        end: momentOf(event.end),
        isAllDay: event.isAllDay ?? null,
        isCancelled: event.isCancelled ?? null,
        organizer: personOf(event.organizer),
        attendees: attendeesOf(event.attendees),
        location: event.location?.displayName ?? null,
        joinUrl: event.onlineMeeting?.joinUrl ?? null,
        webLink: event.webLink ?? null,
        lastModifiedDateTime: event.lastModifiedDateTime ?? null,
        removed,
      };
      const startedAt = graphInstant(event.start);
      const subject = event.subject ?? '(no subject)';
      const summary = cap(
        startedAt === null ? subject : `${subject} ${toLondon(startedAt)}`,
        MAX_SUMMARY_CHARS,
      );
      return Promise.resolve({
        sourceSystem: 'graph',
        recordId: event.id,
        observedAt: record.observedAt,
        record: canonical,
        // A recurring instance correlates with its series, so a move of one
        // occurrence lands on the same trail as the series it belongs to.
        correlationKey: event.seriesMasterId ?? event.id,
        summary,
        labels: ['Calendar'],
        ...(event.webLink === null || event.webLink === undefined ? {} : { url: event.webLink }),
      });
    },
  };
}

/** One overlapping pair, with the dedupe key spec 11 asks for (`event pair`). */
export interface EventConflict {
  first: CalendarEvent;
  second: CalendarEvent;
  dedupeKey: string;
}

interface EventWindow {
  event: CalendarEvent;
  start: number;
  end: number;
}

function windowOf(event: CalendarEvent): EventWindow | null {
  const start = graphInstant(event.start);
  const end = graphInstant(event.end);
  if (start === null || end === null) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  return { event, start: startMs, end: endMs };
}

/**
 * Every pair of live events whose times overlap, for the
 * `calendar_conflict` alert (spec 11). Cancelled events and events without a
 * usable start and end are left out. Two events that merely touch, one
 * ending as the next begins, do not conflict.
 */
export function findConflicts(events: readonly CalendarEvent[]): EventConflict[] {
  const windows = events
    .filter((event) => event.isCancelled !== true)
    .map((event) => windowOf(event))
    .filter((window): window is EventWindow => window !== null)
    .sort((a, b) => a.start - b.start);

  const conflicts: EventConflict[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    const a = windows[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < windows.length; j += 1) {
      const b = windows[j];
      if (b === undefined) continue;
      // Sorted by start, so once one event begins at or after this one ends,
      // no later event can overlap it either.
      if (b.start >= a.end) break;
      conflicts.push({
        first: a.event,
        second: b.event,
        dedupeKey: [a.event.id, b.event.id].sort().join('|'),
      });
    }
  }
  return conflicts;
}

function domainOf(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * The attendees who are not on the internal domain, for the
 * `external_meeting_unknown_attendee` alert (spec 11). An attendee with no
 * readable address counts as external: it cannot be shown to be internal,
 * and the alert exists to surface exactly that doubt.
 */
export function externalAttendees(
  event: CalendarEvent,
  internalDomain: string = INTERNAL_DOMAIN,
): Attendee[] {
  const internal = internalDomain.trim().toLowerCase();
  return (event.attendees ?? []).filter(
    (attendee) => domainOf(attendee.emailAddress?.address) !== internal,
  );
}
