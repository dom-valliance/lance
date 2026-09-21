import { alerts, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
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
}

export interface RaiseAlertResult {
  alertId: string;
  count: number;
  created: boolean;
  eventId: string;
}

/**
 * Records an alert (spec 11). Repeats with the same dedupe key update the
 * existing row and increment its count rather than creating another. Slack
 * delivery and the interruption budget arrive with the alerts engine in
 * Phase 3; this is the durable record they will drain.
 */
export async function raiseAlert(db: Db, input: RaiseAlertInput): Promise<RaiseAlertResult> {
  const ts = nowIso();
  const existing = await db
    .select()
    .from(alerts)
    .where(eq(alerts.dedupeKey, input.dedupeKey))
    .limit(1);
  const row = existing[0];
  let alertId: string;
  let count: number;
  let created: boolean;
  if (row !== undefined && (row.status === 'open' || row.status === 'acked')) {
    const updated = await db
      .update(alerts)
      .set({
        lastSeen: new Date(ts),
        count: sql`${alerts.count} + 1`,
        body: input.body,
        updatedAt: new Date(ts),
      })
      .where(eq(alerts.id, row.id))
      .returning({ count: alerts.count });
    alertId = row.id;
    count = updated[0]?.count ?? row.count + 1;
    created = false;
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
      firstSeen: new Date(ts),
      lastSeen: new Date(ts),
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
    },
  });
  return { alertId, count, created, eventId: event.id };
}
