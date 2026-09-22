import { commitments } from '@lance/db';
import { hashRecord, type ProvenanceRef } from '@lance/shared';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { storedProvenance } from './support.js';

/**
 * `commitment_overdue_outbound` (spec 11): something Dom promised is past
 * its due date. Outbound only, because an inbound promise that slips is a
 * chase (spec 9.2), not an alert.
 */

export const COMMITMENT_OVERDUE_SCHEDULE = '0 * * * *';

/** A promise is not late the minute it is due; a whole day's grace comes first. */
export const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `open` and `chased` are the live states; `done` and `dropped` are finished. */
const LIVE_STATUSES = ['open', 'chased'] as const;

export const commitmentOverdueDetector: Detector = {
  name: 'commitment_overdue_outbound',
  schedule: COMMITMENT_OVERDUE_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const now = context.now();
    const cutoff = new Date(Date.parse(now) - OVERDUE_GRACE_MS);

    const rows = await context.db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.direction, 'outbound'),
          inArray(commitments.status, [...LIVE_STATUSES]),
          isNotNull(commitments.dueAt),
          lt(commitments.dueAt, cutoff),
        ),
      );

    const found: DetectedAlert[] = [];
    for (const row of rows) {
      const dueAt = row.dueAt;
      if (dueAt === null) continue;
      const node = await context.ontology.getNode(row.counterpartyPersonId);
      const displayName = node?.properties['display_name'];
      const counterparty =
        typeof displayName === 'string' && displayName !== ''
          ? displayName
          : row.counterpartyPersonId;
      const days = Math.floor((Date.parse(now) - dueAt.getTime()) / DAY_MS);
      const dayWord = days === 1 ? 'day' : 'days';

      const provenance: ProvenanceRef[] = storedProvenance(row.sourceRefs);
      found.push({
        kind: 'commitment_overdue_outbound',
        severity: 'P1',
        dedupeKey: `commitment:${row.id}`,
        title: `Promise to ${counterparty} is ${String(days)} ${dayWord} overdue`,
        body: [
          `"${row.description}" was due on ${dueAt.toISOString().slice(0, 10)} and is still open, ${String(days)} ${dayWord} later.`,
          `Suggested action: ask Lance to draft a note to ${counterparty}, or mark the commitment done if it has already been met.`,
        ].join(' '),
        provenance:
          provenance.length > 0
            ? provenance
            : [
                {
                  system: 'lance',
                  recordId: `commitments:${row.id}`,
                  hash: hashRecord(row.evidenceQuote),
                  observedAt: row.updatedAt.toISOString(),
                },
              ],
      });
    }
    return found;
  },
};
