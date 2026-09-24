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

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

function localDateParts(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: 'year' | 'month' | 'day'): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(
        `Could not resolve the local date of "${date.toISOString()}" in "${timeZone}"`,
      );
    }
    return Number(value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

/**
 * The instant local midnight starts `parts` in `timeZone`. Offsets are read
 * from `Intl` at a first guess and applied, then read again at the result,
 * which settles on the right side of a daylight saving change.
 */
function localMidnight(parts: LocalDateParts, timeZone: string): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offsetAt = (instant: number): number => {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(local.find((part) => part.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    );
    return asUtc - instant;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/**
 * The start of the local day `workingDays` weekdays after the local date
 * of `from`, in `timeZone`. Saturdays and Sundays are skipped; bank
 * holidays are not. From a Monday, five working days lands on the next
 * Monday; from a Saturday, on the next Friday.
 */
export function addWorkingDays(from: Date, workingDays: number, timeZone: string): Date {
  const start = localDateParts(from, timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  let remaining = workingDays;
  while (remaining > 0) {
    cursor += 24 * 60 * 60 * 1000;
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  const day = new Date(cursor);
  return localMidnight(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
    timeZone,
  );
}

/** "Monday 5 October 2026": a date as UI copy and Slack replies name it, in `timeZone`. */
export function formatLongDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('weekday')} ${value('day')} ${value('month')} ${value('year')}`;
}
