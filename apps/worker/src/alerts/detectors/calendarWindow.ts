import type { DetectorContext } from './types.js';
import {
  addLocalDays,
  latestObservations,
  localDate,
  momentInstant,
  payloadArray,
  payloadRecord,
  payloadString,
  type ObservationRow,
} from './support.js';

/**
 * The calendar as the two calendar detectors read it: the newest
 * observation of each live event starting today or tomorrow, with its wall
 * clocks already resolved to instants. Shared so `calendar_conflict` and
 * `external_meeting_unknown_attendee` cannot disagree about which meetings
 * are in the window.
 */

export const GRAPH_CALENDAR_WATCHER = 'graph-calendar';

export interface EventAttendee {
  name: string | null;
  address: string | null;
  responseStatus: string | null;
}

export interface CalendarEventRow {
  observation: ObservationRow;
  id: string;
  subject: string;
  start: string;
  end: string | null;
  isAllDay: boolean;
  attendees: EventAttendee[];
}

function personOf(entry: unknown, responseStatus: string | null): EventAttendee | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const person = entry as Record<string, unknown>;
  const read = (key: string): string | null => {
    const value = person[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return { name: read('name'), address: read('address'), responseStatus };
}

/**
 * Everyone on the invitation. Graph lists the organiser separately from the
 * attendees and does not always repeat them in the list, so the organiser is
 * folded in here; a meeting organised by an unknown external is otherwise
 * invisible to the unknown attendee detector.
 */
function attendeesOf(payload: Record<string, unknown>): EventAttendee[] {
  const people: EventAttendee[] = [];
  const seen = new Set<string>();
  const add = (person: EventAttendee | null): void => {
    if (person === null) return;
    const key = person.address?.trim().toLowerCase() ?? null;
    if (key !== null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    people.push(person);
  };
  for (const entry of payloadArray(payload, 'attendees')) {
    const attendee = entry as Record<string, unknown> | null;
    const status = attendee?.['responseStatus'];
    add(personOf(entry, typeof status === 'string' && status !== '' ? status : null));
  }
  add(personOf(payload['organizer'], 'organizer'));
  return people;
}

/**
 * Live events starting today or tomorrow in the configured zone. Cancelled
 * events and events Graph has removed are left out: they are not on the
 * calendar any more, whatever the last observation of them says.
 */
export async function calendarWindow(context: DetectorContext): Promise<CalendarEventRow[]> {
  const zone = context.config.timeZone;
  const today = localDate(context.now(), zone);
  const tomorrow = addLocalDays(today, 1);

  const rows = await latestObservations(context.db, {
    sourceSystem: 'graph',
    watcher: GRAPH_CALENDAR_WATCHER,
  });

  const events: CalendarEventRow[] = [];
  for (const row of rows) {
    const payload = row.payload;
    if (payload['removed'] === true || payload['isCancelled'] === true) continue;
    const start = momentInstant(payloadRecord(payload, 'start'), zone);
    if (start === null) continue;
    const day = localDate(start, zone);
    if (day !== today && day !== tomorrow) continue;
    events.push({
      observation: row,
      id: payloadString(payload, 'id') ?? row.sourceRecordId,
      subject: payloadString(payload, 'subject') ?? '(no subject)',
      start,
      end: momentInstant(payloadRecord(payload, 'end'), zone),
      isAllDay: payload['isAllDay'] === true,
      attendees: attendeesOf(payload),
    });
  }
  return events;
}

/** Whether Dom has declined the invitation, in which case the meeting is not his problem. */
export function domDeclined(event: CalendarEventRow, domEmail: string): boolean {
  const email = domEmail.trim().toLowerCase();
  return event.attendees.some(
    (attendee) =>
      attendee.address?.trim().toLowerCase() === email && attendee.responseStatus === 'declined',
  );
}
