import { alerts, type Alert, type Db } from '@lance/db';
import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';

/**
 * The Alerts page's reads and the three writes behind its buttons (spec
 * 12, Alerts). Status, the ack columns and `muted_until` are the only
 * columns the api sets: the rest of an alert is written by whichever
 * watcher raised it.
 */

export interface AlertQuery {
  status?: Alert['status'];
  severity?: Alert['severity'];
  kind?: string;
  /** Rows to return. The caller asks for one more than the page size to learn whether another page exists. */
  limit: number;
  /** The id of the last row of the previous page; rows are ordered by id, newest first. */
  cursor?: string;
}

export interface SetAlertStatusInput {
  id: string;
  /** The statuses the transition is allowed from; part of the WHERE clause. */
  from: Alert['status'][];
  to: Alert['status'];
  at: Date;
  /** Set by an ack, along with the moment of it. */
  ackedBy?: string;
  /** Set by a mute; the alert is suppressed until this instant. */
  mutedUntil?: Date;
}

export interface AlertStoreLike {
  list(query: AlertQuery): Promise<Alert[]>;
  get(id: string): Promise<Alert | null>;
  /** Sets the status of an alert that is still in `from`, and returns the row as it now stands. */
  setStatus(input: SetAlertStatusInput): Promise<Alert | null>;
}

export function createAlertStore(db: Db): AlertStoreLike {
  return {
    async list(query: AlertQuery): Promise<Alert[]> {
      const filters: SQL[] = [];
      if (query.status !== undefined) filters.push(eq(alerts.status, query.status));
      if (query.severity !== undefined) filters.push(eq(alerts.severity, query.severity));
      if (query.kind !== undefined) filters.push(eq(alerts.kind, query.kind));
      if (query.cursor !== undefined) filters.push(lt(alerts.id, query.cursor));

      return db
        .select()
        .from(alerts)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(alerts.id))
        .limit(query.limit);
    },

    async get(id: string): Promise<Alert | null> {
      const rows = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async setStatus(input): Promise<Alert | null> {
      // The `from` statuses are part of the WHERE clause, so two clicks
      // racing each other cannot both append a ledger event.
      const rows = await db
        .update(alerts)
        .set({
          status: input.to,
          updatedAt: input.at,
          ...(input.ackedBy === undefined ? {} : { ackedBy: input.ackedBy, ackedAt: input.at }),
          ...(input.mutedUntil === undefined ? {} : { mutedUntil: input.mutedUntil }),
        })
        .where(and(eq(alerts.id, input.id), inArray(alerts.status, input.from)))
        .returning();
      return rows[0] ?? null;
    },
  };
}
