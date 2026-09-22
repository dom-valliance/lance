/**
 * Dates and relative times for display. All times are stored UTC and
 * displayed Europe/London (root CLAUDE.md); `formatInstant` in
 * proposal-view.ts renders the full "21 Sept 2026, 14:05" form and these
 * helpers cover the date alone, the time alone and the relative labels the
 * design puts beside them ("in 3 h", "2 days ago").
 */

const LONDON = 'Europe/London';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** "21 Sept 2026". */
export function formatDate(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: LONDON }).format(date);
}

/** "14:05". */
export function formatTime(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: LONDON }).format(date);
}

/** "Monday 21 September", for the Today page title. */
export function formatDayTitle(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown day';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: LONDON,
  }).format(date);
}

/** "3 h", "25 min", "2 days": the magnitude of a duration in plain words. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE_MS) return 'under a minute';
  if (abs < HOUR_MS) {
    const minutes = Math.round(abs / MINUTE_MS);
    return `${String(minutes)} min`;
  }
  if (abs < DAY_MS) {
    const hours = Math.round(abs / HOUR_MS);
    return `${String(hours)} h`;
  }
  const days = Math.round(abs / DAY_MS);
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}

/**
 * "in 3 h", "in 2 days", "3 h ago", "yesterday". `now` is injectable so
 * the label is testable and so a server render and a later client render
 * agree on the instant they describe.
 */
export function relativeTo(target: Date | string, now: Date = new Date()): string {
  const date = toDate(target);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) return 'now';
  if (abs >= DAY_MS && abs < 2 * DAY_MS) return diff > 0 ? 'tomorrow' : 'yesterday';
  const duration = formatDuration(diff);
  return diff > 0 ? `in ${duration}` : `${duration} ago`;
}

/** "expires in 3 h" while a deadline is ahead, "expired 2 h ago" once it has passed. */
export function expiryLabel(expiresAt: Date | string, now: Date = new Date()): string {
  const date = toDate(expiresAt);
  if (Number.isNaN(date.getTime())) return 'no expiry';
  const diff = date.getTime() - now.getTime();
  if (diff > 0) return `expires ${relativeTo(date, now)}`;
  const relative = relativeTo(date, now);
  return relative === 'yesterday' ? 'expired yesterday' : `expired ${relative}`;
}

/** "2 min", "5 h", "3 days" from a watcher age in minutes, for status lines. */
export function formatAgeMinutes(ageMinutes: number): string {
  return formatDuration(ageMinutes * MINUTE_MS);
}
