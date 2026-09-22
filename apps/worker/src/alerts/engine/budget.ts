import { ledgerEvents, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { and, eq, gte, sql } from 'drizzle-orm';

/**
 * The interruption budget (spec 9.4): at most `pushBudgetPerHour`
 * unsolicited posts in any rolling hour. Proposal cards count; briefs and
 * boards do not. Every push is a ledger event so the count survives a
 * restart and the Agents page can show it.
 */

export const PUSH_ACTOR = 'system:interruption';
export const PUSH_KIND = 'slack_push';

export type PushReason = 'proposal_card' | 'alert' | 'alert_batch';

export interface PushBudgetDeps {
  db: Db;
  perHour: number;
  now?: () => string;
}

export async function pushesInLastHour(db: Db, now: string): Promise<number> {
  const since = new Date(new Date(now).getTime() - 3600 * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.kind, 'resolved'),
        gte(ledgerEvents.ts, since),
        sql`${ledgerEvents.payload} ->> 'kind' = ${PUSH_KIND}`,
      ),
    );
  return rows[0]?.count ?? 0;
}

/** How many more unsolicited posts the hour allows. */
export async function remainingPushes(deps: PushBudgetDeps): Promise<number> {
  const used = await pushesInLastHour(deps.db, (deps.now ?? nowIso)());
  return Math.max(0, deps.perHour - used);
}

/** Records one unsolicited post against the budget. */
export async function recordPush(
  db: Db,
  input: {
    reason: PushReason;
    correlationId?: string;
    slackTs: string;
    ids?: string[];
    now?: () => string;
  },
): Promise<void> {
  await new LedgerWriter(db).append({
    ts: (input.now ?? nowIso)(),
    actor: PUSH_ACTOR,
    kind: 'resolved',
    sourceSystem: 'slack',
    sourceRecordId: input.slackTs,
    correlationId: input.correlationId ?? newUlid(),
    payload: { kind: PUSH_KIND, reason: input.reason, ids: input.ids ?? [] },
  });
}
