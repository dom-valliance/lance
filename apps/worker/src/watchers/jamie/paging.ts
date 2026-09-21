/**
 * Window and paging arithmetic shared by the two Jamie partitions
 * (spec 7.1, ADR 0005).
 *
 * Jamie carries no updated-at on a meeting and a transcript lands minutes
 * to hours after the meeting ends, so neither partition can poll from a
 * point in time. Both poll a window that reaches back behind the cursor,
 * and both rely on the idempotency key to drop what has not changed.
 */

/** First run, cursor null: reach back a fortnight so the ledger starts with recent history. */
export const JAMIE_FIRST_RUN_DAYS = 14;

/** Later runs: reach back behind the cursor, far enough to catch a late transcript. */
export const JAMIE_OVERLAP_HOURS = 72;

/**
 * A poll walks at most this many pages. Jamie's default page is 50 rows, so
 * the cap is thousands of rows: reaching it means the window or the account
 * is wrong, not that Lance is behind.
 */
export const JAMIE_MAX_PAGES = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Where the poll window opens: the cursor less the overlap, or a fortnight
 * back on the first run. An unreadable cursor is treated as a first run
 * rather than sent to Jamie as rubbish.
 */
export function windowStart(cursor: string | null, now: string): string {
  const nowMs = Date.parse(now);
  if (cursor !== null) {
    const cursorMs = Date.parse(cursor);
    if (!Number.isNaN(cursorMs))
      return new Date(cursorMs - JAMIE_OVERLAP_HOURS * HOUR_MS).toISOString();
  }
  return new Date(nowMs - JAMIE_FIRST_RUN_DAYS * DAY_MS).toISOString();
}

export interface JamiePage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Follows Jamie's `nextCursor` to the end of the window. The connector
 * exposes no paging helper, so the loop lives here; it is bounded by
 * `JAMIE_MAX_PAGES` and throws when the cap is reached, which the watcher
 * runner counts towards the partition's breaker.
 */
export async function collectPages<T>(
  partition: string,
  fetchPage: (cursor: string | undefined) => Promise<JamiePage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < JAMIE_MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
  throw new Error(
    `jamie ${partition} poll reached the ${String(JAMIE_MAX_PAGES)} page cap with more pages waiting. ` +
      'Shorten the poll window or raise JAMIE_MAX_PAGES in apps/worker/src/watchers/jamie/paging.ts.',
  );
}

/** The newest of the given instants as an ISO string, or the fallback when none can be read. */
export function newestInstant(
  values: readonly (string | null | undefined)[],
  fallback: string | null,
): string | null {
  let newest: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest === null ? fallback : new Date(newest).toISOString();
}

/** True when both addresses name the same mailbox, ignoring case and surrounding space. */
export function sameEmail(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a !== '' && a === b;
}

/** Shortens text to `limit` characters. Summaries are for a Slack line, not a record. */
export function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** The date part of an instant in Europe/London, for a human-readable summary line. */
export function londonDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'medium',
  }).format(date);
}
