/**
 * Time helpers. No date library (Valliance minimal-dependencies rule): every
 * calendar-aware operation here is a thin wrapper over `Intl.DateTimeFormat`,
 * which already carries the IANA time zone database.
 */

/** The current instant as an ISO-8601 string with an explicit UTC offset. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Formats an ISO instant for display in Europe/London, honouring British
 * Summer Time. Used wherever UI copy or logs show a timestamp to a human
 * (CLAUDE.md: "All times stored UTC, displayed Europe/London").
 */
export function toLondon(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

interface LocalHourMinute {
  hour: number;
  minute: number;
}

function localHourMinute(iso: string, timeZone: string): LocalHourMinute {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hourPart = parts.find((part) => part.type === 'hour')?.value;
  const minutePart = parts.find((part) => part.type === 'minute')?.value;
  if (hourPart === undefined || minutePart === undefined) {
    throw new Error(`Could not resolve local time for "${iso}" in time zone "${timeZone}"`);
  }
  return { hour: Number(hourPart), minute: Number(minutePart) };
}

function minutesSinceMidnight({ hour, minute }: LocalHourMinute): number {
  return hour * 60 + minute;
}

function parseHhMm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`Expected "HH:MM", received "${value}"`);
  }
  const [, hourText, minuteText] = match;
  return Number(hourText) * 60 + Number(minuteText);
}

/**
 * Whether the instant `iso` falls within the quiet-hours window
 * `[start, end)`, evaluated in `timeZone`. `start` is inclusive, `end` is
 * exclusive, so the boundary minute itself is quiet and the end boundary
 * minute is not. When `end` is not after `start` (for example "19:00" to
 * "07:00"), the window is treated as crossing midnight.
 */
export function isWithinQuietHours(
  iso: string,
  start: string,
  end: string,
  timeZone: string,
): boolean {
  const startMinutes = parseHhMm(start);
  const endMinutes = parseHhMm(end);
  const nowMinutes = minutesSinceMidnight(localHourMinute(iso, timeZone));

  if (startMinutes === endMinutes) {
    // A zero-width or full-day window: treat as always quiet, matching the
    // "window covers everything" reading rather than "window covers nothing".
    return true;
  }

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  // Crosses midnight: quiet from start through end of day, and from start
  // of day through end.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** Whether the instant `iso` falls on a Saturday or Sunday in `timeZone`. */
export function isWeekend(iso: string, timeZone: string): boolean {
  const date = new Date(iso);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' })
    .formatToParts(date)
    .find((part) => part.type === 'weekday')?.value;
  if (weekday === undefined) {
    throw new Error(`Could not resolve local weekday for "${iso}" in time zone "${timeZone}"`);
  }
  return weekday === 'Sat' || weekday === 'Sun';
}
