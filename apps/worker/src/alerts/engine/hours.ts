/**
 * Working hours and quiet hours (spec 9.4), evaluated in the configured
 * time zone. Quiet hours run from `quietHoursStart` to `quietHoursEnd`
 * overnight, and the whole weekend is quiet.
 */

export interface QuietHours {
  quietHoursStart: string;
  quietHoursEnd: string;
}

interface LocalClock {
  weekday: number;
  minutes: number;
}

function localClock(instant: string, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    weekday: weekdays.indexOf(read('weekday')),
    minutes: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True during quiet hours or at the weekend. */
export function isQuiet(instant: string, timeZone: string, hours: QuietHours): boolean {
  const clock = localClock(instant, timeZone);
  if (clock.weekday === 0 || clock.weekday === 6) return true;
  const start = minutesOf(hours.quietHoursStart);
  const end = minutesOf(hours.quietHoursEnd);
  // Overnight window: quiet from start to midnight and from midnight to end.
  return start > end
    ? clock.minutes >= start || clock.minutes < end
    : clock.minutes >= start && clock.minutes < end;
}

/**
 * The next instant quiet hours end: the next weekday at `quietHoursEnd`
 * local time. Walks forward a minute at a time from `instant`, which is
 * exact and needs no zone arithmetic of its own.
 */
export function nextQuietEnd(instant: string, timeZone: string, hours: QuietHours): string {
  let cursor = new Date(instant).getTime();
  const step = 60 * 1000;
  for (let i = 0; i < 4 * 24 * 60; i += 1) {
    cursor += step;
    const iso = new Date(cursor).toISOString();
    if (!isQuiet(iso, timeZone, hours)) return iso;
  }
  return new Date(cursor).toISOString();
}
