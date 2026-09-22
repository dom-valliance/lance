import { proposals } from '@lance/db';
import { hashRecord } from '@lance/shared';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { localDateTime, storedProvenance } from './support.js';

/**
 * `proposal_expiring` (spec 11): "6 h before expiry, only for client
 * counterparty". An internal proposal that lapses costs a retry; a client
 * one costs a reply Dom meant to send.
 */

export const PROPOSAL_EXPIRING_SCHEDULE = '*/15 * * * *';

/** Spec 11: six hours of warning. */
export const EXPIRY_WARNING_HOURS = 6;

const HOUR_MS = 60 * 60 * 1000;

export const proposalExpiringDetector: Detector = {
  name: 'proposal_expiring',
  schedule: PROPOSAL_EXPIRING_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const zone = context.config.timeZone;
    const now = context.now();
    const nowMs = Date.parse(now);
    const rows = await context.db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.status, 'pending'),
          eq(proposals.counterpartyClass, 'client'),
          gt(proposals.expiresAt, new Date(nowMs)),
          lte(proposals.expiresAt, new Date(nowMs + EXPIRY_WARNING_HOURS * HOUR_MS)),
        ),
      );

    return rows.map((row) => {
      const hours = (row.expiresAt.getTime() - nowMs) / HOUR_MS;
      const provenance = storedProvenance(row.provenance);
      return {
        kind: 'proposal_expiring',
        severity: 'P2',
        dedupeKey: `proposal:${row.id}`,
        title: `Client proposal expires in ${hours.toFixed(1)} hours`,
        body: [
          `${row.preview} It expires at ${localDateTime(row.expiresAt.toISOString(), zone)} and will be dropped unopened after that.`,
          'Suggested action: approve, edit or reject it in Slack or on the Proposals page before it lapses.',
        ].join(' '),
        provenance:
          provenance.length > 0
            ? provenance
            : [
                {
                  system: 'lance' as const,
                  recordId: `proposals:${row.id}`,
                  hash: hashRecord(row.payload),
                  observedAt: row.createdAt.toISOString(),
                },
              ],
      };
    });
  },
};
