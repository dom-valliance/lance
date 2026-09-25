import { ledgerEvents } from '@lance/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from './writer.js';

/**
 * The ledger's record of onboarding (docs/plans/multi-user.md M3). Each
 * step records a `state_changed` event in the principal's own scope when
 * it completes, and the checklist reads its state back from those events,
 * so the ledger is the one place onboarding progress lives.
 *
 * `graph_connected` and `jamie_connected` are written by the api after it
 * stores the principal's secret (the api may set a secret in the principal
 * vault and never read one back, ADR 0022, so these events are how it knows
 * a secret exists). `mailbox_settings_read` is the worker's, after it reads
 * the principal's mailbox settings.
 */
export const ONBOARDING_CHANGES = {
  noticeAccepted: 'notice_accepted',
  graphConnected: 'graph_connected',
  jamieConnected: 'jamie_connected',
  mailboxSettingsRead: 'mailbox_settings_read',
  preferencesConfirmed: 'preferences_confirmed',
  completed: 'onboarding_completed',
} as const;

export type OnboardingChange = (typeof ONBOARDING_CHANGES)[keyof typeof ONBOARDING_CHANGES];

/** The ledger actor of the activation, which no person performs by hand. */
export const ONBOARDING_ACTOR = 'system:onboarding';

export interface StateChangeEvent {
  id: string;
  ts: Date;
  payload: Record<string, unknown> | null;
}

/**
 * The newest `state_changed` event for each of `changes` in the session's
 * scope, by change. Newest is by ledger id, a monotonic ULID, not by `ts`
 * (CLAUDE.md gotcha on ordering).
 */
export async function latestStateChanges(
  executor: DbExecutor,
  changes: readonly OnboardingChange[],
): Promise<Map<OnboardingChange, StateChangeEvent>> {
  const change = sql<string>`${ledgerEvents.payload}->>'change'`;
  const rows = await executor
    .selectDistinctOn([change], {
      id: ledgerEvents.id,
      ts: ledgerEvents.ts,
      payload: ledgerEvents.payload,
      change,
    })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.kind, 'state_changed'), inArray(change, [...changes])))
    .orderBy(change, desc(ledgerEvents.id));
  const out = new Map<OnboardingChange, StateChangeEvent>();
  for (const row of rows) {
    const payload =
      typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null;
    out.set(row.change as OnboardingChange, { id: row.id, ts: row.ts, payload });
  }
  return out;
}
