import type { Db } from '@lance/db';
import { ledgerEvents, observations } from '@lance/db';
import { eq, sql } from 'drizzle-orm';
import { observedProvenance, readString, readStringArray } from './writer.js';

/**
 * Rebuilds the observations table from observed ledger events. Runs under a
 * role that may delete from observations (the migrator); lance_app cannot.
 */
export async function rebuildObservations(db: Db): Promise<{ rebuilt: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM ${observations}`);
    const events = await tx.select().from(ledgerEvents).where(eq(ledgerEvents.kind, 'observed'));
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | null;
      const provenance = observedProvenance(event);
      await tx.insert(observations).values({
        id: event.id,
        ts: event.ts,
        ...provenance,
        correlationId: event.correlationId,
        summary: readString(payload, 'summary'),
        labels: readStringArray(payload, 'labels'),
        payload,
      });
    }
    return { rebuilt: events.length };
  });
}
