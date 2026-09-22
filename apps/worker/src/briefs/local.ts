/** Date arithmetic in the configured zone, without a library. */

/** Milliseconds the zone is ahead of UTC at `date`. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight at the start of `date`'s local day, as an instant. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const offset = zoneOffsetMs(date, timeZone);
  const local = new Date(date.getTime() + offset);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const candidate = new Date(localMidnight - offset);
  const candidateOffset = zoneOffsetMs(candidate, timeZone);
  return candidateOffset === offset ? candidate : new Date(localMidnight - candidateOffset);
}

/** `YYYY-MM-DD` of `date` in the zone. */
export function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** Windows zone names Graph may send, mapped to IANA. Anything else is read as `fallback`. */
const WINDOWS_ZONES: Record<string, string> = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Etc/GMT',
  UTC: 'Etc/UTC',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Warsaw',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Pacific Standard Time': 'America/Los_Angeles',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

function ianaZone(name: string | null, fallback: string): string {
  if (name === null || name === '') return fallback;
  if (WINDOWS_ZONES[name] !== undefined) return WINDOWS_ZONES[name];
  try {
    void new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return name;
  } catch {
    return fallback;
  }
}

/**
 * A Graph wall-clock `dateTime` (`YYYY-MM-DDTHH:mm:ss.fffffff`) in the
 * named zone, as an instant. Graph's seven fractional digits are cut to
 * three before parsing.
 */
export function instantOf(
  moment: { dateTime: string; timeZone: string | null } | null,
  fallbackZone: string,
): Date | null {
  if (moment === null) return null;
  const zone = ianaZone(moment.timeZone, fallbackZone);
  const trimmed = moment.dateTime.replace(/(\.\d{3})\d+$/, '$1');
  const naive = new Date(`${trimmed}Z`);
  if (Number.isNaN(naive.getTime())) return null;
  // Interpret the wall clock in the zone: subtract the zone's offset at
  // roughly that instant, then correct once for a DST edge.
  const first = new Date(naive.getTime() - zoneOffsetMs(naive, zone));
  return new Date(naive.getTime() - zoneOffsetMs(first, zone));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}
