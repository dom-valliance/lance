import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { calendarWindow, domDeclined, type CalendarEventRow } from './calendarWindow.js';
import { localDateTime, provenanceOf } from './support.js';

/**
 * `calendar_conflict` (spec 11): two meetings today or tomorrow whose times
 * overlap. Two events that merely touch, one ending as the next begins, do
 * not conflict. All-day events do not conflict with anything: they are
 * markers, not appointments.
 */

export const CALENDAR_CONFLICT_SCHEDULE = '*/15 * * * *';

interface Window {
  event: CalendarEventRow;
  start: number;
  end: number;
}

function windowOf(event: CalendarEventRow): Window | null {
  if (event.isAllDay || event.end === null) return null;
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { event, start, end };
}

export const calendarConflictDetector: Detector = {
  name: 'calendar_conflict',
  schedule: CALENDAR_CONFLICT_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const zone = context.config.timeZone;
    const domEmail = context.config.dom.email;
    const windows = (await calendarWindow(context))
      .filter((event) => !domDeclined(event, domEmail))
      .flatMap((event) => {
        const window = windowOf(event);
        return window === null ? [] : [window];
      })
      .sort((a, b) => a.start - b.start);

    const found: DetectedAlert[] = [];
    for (let i = 0; i < windows.length; i += 1) {
      const a = windows[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < windows.length; j += 1) {
        const b = windows[j];
        if (b === undefined) continue;
        // Sorted by start, so once one event begins at or after this one
        // ends, no later event can overlap it either.
        if (b.start >= a.end) break;
        const [first, second] = a.event.id < b.event.id ? [a.event, b.event] : [b.event, a.event];
        found.push({
          kind: 'calendar_conflict',
          severity: 'P1',
          dedupeKey: `events:${first.id}:${second.id}`,
          title: `Calendar clash: ${first.subject} overlaps ${second.subject}`,
          body: [
            `"${first.subject}" runs from ${localDateTime(first.start, zone)}${first.end === null ? '' : ` to ${localDateTime(first.end, zone)}`} and "${second.subject}" from ${localDateTime(second.start, zone)}${second.end === null ? '' : ` to ${localDateTime(second.end, zone)}`}.`,
            'Suggested action: decline or move one of them, or send someone else to it.',
          ].join(' '),
          provenance: [provenanceOf(first.observation), provenanceOf(second.observation)],
        });
      }
    }
    return found;
  },
};
