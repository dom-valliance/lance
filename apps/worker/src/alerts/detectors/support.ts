import { newestObservationFirst, observations, type Db } from '@lance/db';
import { ProvenanceRefSchema, type ProvenanceRef } from '@lance/shared';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The reading a detector does before it decides anything (spec 11). Nothing
 * here raises an alert or writes: detectors are pure functions of what the
 * ledger already holds, which is what makes them re-runnable every quarter
 * of an hour without consequence.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One observation, reduced to the fields a detector reads. */
export interface ObservationRow {
  id: string;
  ts: Date;
  sourceSystem: string;
  sourceRecordId: string;
  sourceRecordHash: string;
  payload: Record<string, unknown>;
}

/**
 * The newest observation of each source record a watcher produced. A moved
 * meeting or an edited mail is a fresh observation of the same record, so
 * only the newest one describes the world now.
 */
export async function latestObservations(
  db: Db,
  options: { sourceSystem: string; watcher: string },
): Promise<ObservationRow[]> {
  const rows = await db
    .selectDistinctOn([observations.sourceRecordId], {
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      sourceRecordHash: observations.sourceRecordHash,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        eq(observations.sourceSystem, options.sourceSystem),
        sql`${observations.payload} ->> 'watcher' = ${options.watcher}`,
      ),
    )
    .orderBy(...newestObservationFirst());

  return rows.flatMap((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    if (payload === null) return [];
    return [{ ...row, payload }];
  });
}

/** Non-negotiable 5: every claim carries where it came from. */
export function provenanceOf(row: ObservationRow): ProvenanceRef {
  const url = row.payload['url'];
  return {
    system: row.sourceSystem as ProvenanceRef['system'],
    recordId: row.sourceRecordId,
    hash: row.sourceRecordHash,
    observedAt: row.ts.toISOString(),
    ...(typeof url === 'string' && url !== '' ? { url } : {}),
  };
}

/** The provenance refs stored on a commitment or a proposal, ignoring anything malformed. */
export function storedProvenance(value: unknown): ProvenanceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ProvenanceRef[] = [];
  for (const entry of value) {
    const parsed = ProvenanceRefSchema.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

export function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function payloadRecord(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function payloadArray(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

// Dates in the configured zone. No date library (Valliance minimal-dependency
// rule): `Intl` already carries the IANA database.

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

/** The calendar day an instant falls on in `timeZone`, as `YYYY-MM-DD`. */
/** An instant for alert copy, in the configured zone (CLAUDE.md: stored UTC, displayed in `config.timeZone`). */
export function localDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Midnight at the start of a `YYYY-MM-DD` local day, as a UTC instant. */
export function localDayStart(date: string, timeZone: string): string {
  const asUtc = Date.parse(`${date}T00:00:00Z`);
  // Two passes: the first offset is read at the wrong instant when midnight
  // sits near a daylight-saving change, the second at the right one.
  const firstPass = asUtc - zoneOffsetMs(asUtc, timeZone);
  return new Date(asUtc - zoneOffsetMs(firstPass, timeZone)).toISOString();
}

/** Whole days added to a `YYYY-MM-DD` date, still `YYYY-MM-DD`. */
export function addLocalDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The Windows zone names Graph sends most often, mapped to IANA names.
 * Graph returns a zone name, never an offset, and `Intl` cannot read the
 * Windows spelling. Anything outside this table falls back to the
 * configured zone rather than to UTC: Lance's calendar is a London
 * calendar, so guessing local is far less wrong than guessing Greenwich.
 */
export const WINDOWS_TIME_ZONES: Readonly<Record<string, string>> = {
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Etc/GMT',
  utc: 'UTC',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kiev',
  'e. europe standard time': 'Europe/Chisinau',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata',
  'singapore standard time': 'Asia/Singapore',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
};

/** The IANA zone a Graph zone name means, or the fallback when it names none Lance knows. */
export function resolveTimeZone(timeZone: string | null, fallbackZone: string): string {
  if (timeZone === null || timeZone.trim() === '') return 'UTC';
  const name = timeZone.trim();
  if (name.toUpperCase() === 'UTC') return 'UTC';
  if (isValidTimeZone(name)) return name;
  return WINDOWS_TIME_ZONES[name.toLowerCase()] ?? fallbackZone;
}

/**
 * A Graph wall clock plus its zone name, as a UTC instant. A `dateTime`
 * that already carries an offset is taken at its word and the zone name is
 * ignored.
 */
export function momentInstant(
  moment: { dateTime?: unknown; timeZone?: unknown } | null,
  fallbackZone: string,
): string | null {
  if (moment === null) return null;
  const dateTime = typeof moment.dateTime === 'string' ? moment.dateTime.trim() : '';
  if (dateTime === '') return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime);
  const asUtc = Date.parse(hasOffset ? dateTime : `${dateTime}Z`);
  if (Number.isNaN(asUtc)) return null;
  if (hasOffset) return new Date(asUtc).toISOString();

  const zone = resolveTimeZone(
    typeof moment.timeZone === 'string' ? moment.timeZone : null,
    fallbackZone,
  );
  if (zone === 'UTC') return new Date(asUtc).toISOString();
  const firstPass = asUtc - zoneOffsetMs(asUtc, zone);
  return new Date(asUtc - zoneOffsetMs(firstPass, zone)).toISOString();
}

/** The email domain of an address, lower case, or null when it has none. */
export function domainOf(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.trim().length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain === '' ? null : domain;
}
