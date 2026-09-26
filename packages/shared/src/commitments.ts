/**
 * Commitment timing the worker and the api share, so a date the worker
 * extracted and a date the principal typed schedule the same chase.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after the due date an inbound commitment is first chased. */
export const CHASE_GRACE_DAYS = 2;

/** The local time a due date typed as a bare day stands for: the end of the working day. */
export const DUE_TIME_OF_DAY = '17:00';

/** The first chase of an inbound commitment due at `due`. */
export function firstChaseAt(due: Date): Date {
  return new Date(due.getTime() + CHASE_GRACE_DAYS * DAY_MS);
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minutes the zone's wall clock is ahead of UTC at `instant`. */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  return Math.round((wall - instant) / 60_000);
}

/**
 * The instant a due date typed as `YYYY-MM-DD` stands for: 17:00 on that
 * day in `timeZone`, honouring daylight saving. Throws on anything that is
 * not a real calendar day, naming the value.
 */
export function dueAtFromDay(day: string, timeZone: string): Date {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    throw new Error(`A due date must be a day written YYYY-MM-DD; received "${day}".`);
  }
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [hour, minute] = DUE_TIME_OF_DAY.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error(`"${day}" is not a calendar day. Choose the date again.`);
  }
  // The offset at the wall-clock guess is right except within an hour of a
  // daylight saving change, and 17:00 is never within that hour in London.
  return new Date(wall - offsetMinutes(wall, timeZone) * 60_000);
}
