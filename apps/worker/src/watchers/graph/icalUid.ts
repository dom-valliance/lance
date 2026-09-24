import { observations, type Db } from '@lance/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { GRAPH_CALENDAR_WATCHER_NAME } from './calendar.js';

/**
 * The iCalUId of one of the principal's own calendar events, from the
 * calendar watcher's observations (`GraphCalendarRecord.iCalUId`), given
 * the event's Graph id. Every attendee's copy of a meeting shares the
 * iCalUId, so it is the key a shared Meeting node is found by (ADR 0017).
 * The handle's scope keeps the read to the principal's own mailbox. Null
 * when no observation of the event carries one: a removal is recorded
 * with no iCalUId, so the newest observation that has one answers.
 */
export async function icalUidOfGraphEvent(db: Db, graphEventId: string): Promise<string | null> {
  const rows = await db
    .select({ icalUid: sql<string | null>`${observations.payload} ->> 'iCalUId'` })
    .from(observations)
    .where(
      and(
        eq(observations.sourceSystem, 'graph'),
        eq(observations.sourceRecordId, graphEventId),
        sql`${observations.payload} ->> 'watcher' = ${GRAPH_CALENDAR_WATCHER_NAME}`,
        sql`coalesce(${observations.payload} ->> 'iCalUId', '') <> ''`,
      ),
    )
    .orderBy(desc(observations.id))
    .limit(1);
  return rows[0]?.icalUid ?? null;
}
