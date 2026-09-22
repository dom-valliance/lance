import type { alerts } from '@lance/db';
import type { Alert } from '@lance/shared';

/**
 * The read side of `alerts`: one mapper from the database row to the shared
 * `Alert` the Slack renderer takes. It sits beside `proposalView.ts` for
 * the same reason: the worker raises alerts and the api answers their
 * buttons, so neither app imports the other.
 */

export type AlertRow = typeof alerts.$inferSelect;

/**
 * Maps an alerts row to the shared Alert shape `renderAlertCard` takes.
 * `kind` is `text` in the schema and a union in the shared type; the
 * watchers are the only writers and every one of them writes an
 * `AlertKind`, so the value is asserted rather than re-validated here.
 */
export function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    severity: row.severity,
    kind: row.kind as Alert['kind'],
    dedupeKey: row.dedupeKey,
    title: row.title,
    body: row.body,
    provenance: row.provenance as Alert['provenance'],
    status: row.status,
    firstSeen: row.firstSeen.toISOString(),
    lastSeen: row.lastSeen.toISOString(),
    count: row.count,
    ackedBy: row.ackedBy,
    ackedAt: row.ackedAt === null ? null : row.ackedAt.toISOString(),
    slackTs: row.slackTs,
  };
}
