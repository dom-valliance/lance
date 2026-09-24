import { alerts, type Db } from '@lance/db';
import { LedgerWriter } from './writer.js';
import {
  newUlid,
  nowIso,
  type AlertKind,
  type AlertSeverity,
  type ProvenanceRef,
} from '@lance/shared';
import { eq, sql } from 'drizzle-orm';

export interface RaiseAlertInput {
  kind: AlertKind;
  severity: AlertSeverity;
  dedupeKey: string;
  title: string;
  body: string;
  provenance?: ProvenanceRef[];
  actor: string;
  correlationId?: string;
  now?: () => string;
}

export interface RaiseAlertResult {
  alertId: string;
  count: number;
  created: boolean;
  /** True when a resolved alert, or a muted one whose mute had lapsed, came back as open. */
  reopened: boolean;
  eventId: string;
}

/**
 * Records an alert (spec 11), in the scope `db` carries. The dedupe key names one row for the
 * condition, whatever its status: repeats raise the count and refresh the
 * body. An open or acked row stays as it is. A muted row stays muted while
 * the mute lasts. A resolved row, or a muted row whose mute has lapsed,
 * reopens with a fresh card, since the condition is back.
 */
export async function raiseAlert(db: Db, input: RaiseAlertInput): Promise<RaiseAlertResult> {
  const ts = (input.now ?? nowIso)();
  const at = new Date(ts);
  const existing = await db
    .select()
    .from(alerts)
    .where(eq(alerts.dedupeKey, input.dedupeKey))
    .limit(1);
  const row = existing[0];
  let alertId: string;
  let count: number;
  let created = false;
  let reopened = false;
  if (row !== undefined) {
    const muteLapsed = row.mutedUntil === null || row.mutedUntil <= at;
    reopened = row.status === 'resolved' || (row.status === 'suppressed' && muteLapsed);
    const updated = await db
      .update(alerts)
      .set({
        lastSeen: at,
        count: sql`${alerts.count} + 1`,
        body: input.body,
        severity: input.severity,
        updatedAt: at,
        ...(reopened
          ? { status: 'open', slackTs: null, batchTs: null, ackedBy: null, ackedAt: null }
          : {}),
      })
      .where(eq(alerts.id, row.id))
      .returning({ count: alerts.count });
    alertId = row.id;
    count = updated[0]?.count ?? row.count + 1;
  } else {
    alertId = newUlid();
    await db.insert(alerts).values({
      id: alertId,
      severity: input.severity,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      title: input.title,
      body: input.body,
      provenance: input.provenance ?? [],
      status: 'open',
      firstSeen: at,
      lastSeen: at,
      count: 1,
    });
    count = 1;
    created = true;
  }
  const event = await new LedgerWriter(db).append({
    ts,
    actor: input.actor,
    kind: 'alert_raised',
    sourceSystem: 'lance',
    correlationId: input.correlationId ?? newUlid(),
    payload: {
      alertId,
      kind: input.kind,
      severity: input.severity,
      dedupeKey: input.dedupeKey,
      title: input.title,
      count,
      created,
      reopened,
    },
  });
  return { alertId, count, created, reopened, eventId: event.id };
}
