import type { Alert } from '@lance/db';
import { ProvenanceRefSchema, type ProvenanceRef } from '@lance/shared';

/**
 * The shape the Alerts page renders (spec 12, Alerts row). Dates leave the
 * api as ISO strings, as the rest of the router does, and `mutedUntil` is
 * carried alongside the status so the page can say how long a suppressed
 * alert stays quiet.
 */

export interface AlertView {
  id: string;
  kind: string;
  severity: Alert['severity'];
  status: Alert['status'];
  title: string;
  body: string;
  /** How many times the dedupe key has been seen. */
  count: number;
  firstSeen: string;
  lastSeen: string;
  ackedBy: string | null;
  ackedAt: string | null;
  mutedUntil: string | null;
  provenance: ProvenanceRef[];
  slackTs: string | null;
}

/**
 * The stored `provenance` as refs. A ref that does not parse is dropped
 * rather than thrown: the row still renders the ones that do, and
 * non-negotiable 5 is satisfied by what it shows.
 */
export function provenanceOf(value: unknown): ProvenanceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ProvenanceRef[] = [];
  for (const entry of value) {
    const parsed = ProvenanceRefSchema.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

export function toAlertView(row: Alert): AlertView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    body: row.body,
    count: row.count,
    firstSeen: row.firstSeen.toISOString(),
    lastSeen: row.lastSeen.toISOString(),
    ackedBy: row.ackedBy,
    ackedAt: row.ackedAt === null ? null : row.ackedAt.toISOString(),
    mutedUntil: row.mutedUntil === null ? null : row.mutedUntil.toISOString(),
    provenance: provenanceOf(row.provenance),
    slackTs: row.slackTs,
  };
}
