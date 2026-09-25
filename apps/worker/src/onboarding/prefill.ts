import type { MailboxSettings } from '@lance/connectors';
import { principalState, principals, scopedDb, type Db, type Principal } from '@lance/db';
import { LedgerWriter, ONBOARDING_CHANGES, latestStateChanges } from '@lance/ledger';
import { ianaTimeZone, newUlid, nowIso } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { ConnectorLookup } from '../jobs/connectors.js';

/**
 * Onboarding step 6's prefill (docs/plans/multi-user.md M3). Once a
 * principal in status `onboarding` has connected Microsoft 365, the worker,
 * which holds their Graph token, reads their mailbox settings once and
 * stores a time zone and quiet hours from them on `principals.time_zone`
 * and `principal_state`, where the checklist shows them for the principal
 * to confirm or edit.
 *
 * It runs as the locked organisation job `onboarding-prefill` every minute
 * rather than as a per-principal job: per-principal jobs fan out to active
 * principals only, and an onboarding principal is not one yet. A sweep
 * also needs no hand-off from the api's consent callback and retries on
 * its own after a failed read. A principal is read once per consent: when
 * a `mailbox_settings_read` event is newer than their `graph_connected`.
 *
 * The same connector lookup resolves the principal's Notion user id from
 * the organisation integration when it is not recorded yet, so it is in
 * place when onboarding completes; the first context build after
 * activation tries again if no Notion user matched.
 */

export const ONBOARDING_PREFILL_ACTOR = 'system:onboarding-prefill';

/** Quiet hours when the mailbox names no working hours, as `principal_state` declares them. */
const DEFAULT_QUIET_HOURS = { quietHoursStart: '19:00', quietHoursEnd: '07:00' };

export interface MailboxPreferences {
  /** An IANA zone, or null when Graph named one Lance cannot place. */
  timeZone: string | null;
  /** What Graph reported, for the ledger. */
  mailboxTimeZone: string | null;
  quietHoursStart: string;
  quietHoursEnd: string;
  /** False when the mailbox has no working hours and the defaults stand. */
  fromWorkingHours: boolean;
}

/** `09:00:00.0000000` becomes `09:00`; anything else is null. */
const hhMm = (value: string | null | undefined): string | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value ?? '');
  return match === null ? null : `${match[1] ?? ''}:${match[2] ?? ''}`;
};

/**
 * Quiet hours run from the end of the working day to its start. The
 * mailbox's own zone wins over the working hours' zone, which Outlook sets
 * separately and usually to the same place.
 */
export function preferencesFromMailbox(settings: MailboxSettings): MailboxPreferences {
  const mailboxTimeZone = settings.timeZone ?? settings.workingHours?.timeZone?.name ?? null;
  const timeZone =
    ianaTimeZone(settings.timeZone) ?? ianaTimeZone(settings.workingHours?.timeZone?.name);
  const start = hhMm(settings.workingHours?.startTime);
  const end = hhMm(settings.workingHours?.endTime);
  const usable = start !== null && end !== null && start !== end;
  return {
    timeZone,
    mailboxTimeZone,
    ...(usable ? { quietHoursStart: end, quietHoursEnd: start } : DEFAULT_QUIET_HOURS),
    fromWorkingHours: usable,
  };
}

export interface PrefillOptions {
  /** Unscoped; each principal's work runs in their own scope. */
  root: Db;
  connectorsFor: ConnectorLookup;
  now?: () => string;
  log?: (entry: Record<string, unknown>, message: string) => void;
}

export interface PrefillResult {
  /** Principals whose mailbox settings were read this run. */
  read: string[];
  /** Principals whose read failed; the next run tries again. */
  failed: string[];
}

/** True when the principal has connected and their settings have not been read since. */
async function needsRead(db: Db): Promise<boolean> {
  const events = await latestStateChanges(db, [
    ONBOARDING_CHANGES.graphConnected,
    ONBOARDING_CHANGES.mailboxSettingsRead,
  ]);
  const connected = events.get(ONBOARDING_CHANGES.graphConnected);
  if (connected === undefined) return false;
  const read = events.get(ONBOARDING_CHANGES.mailboxSettingsRead);
  return read === undefined || read.id < connected.id;
}

/** Stores the prefill, unless the principal has already confirmed values of their own. */
async function store(
  db: Db,
  principal: Principal,
  preferences: MailboxPreferences,
  ts: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const confirmed = await latestStateChanges(tx, [ONBOARDING_CHANGES.preferencesConfirmed]);
    const applied = !confirmed.has(ONBOARDING_CHANGES.preferencesConfirmed);
    if (applied) {
      await tx.insert(principalState).values({}).onConflictDoNothing();
      await tx
        .update(principalState)
        .set({
          quietHoursStart: preferences.quietHoursStart,
          quietHoursEnd: preferences.quietHoursEnd,
          updatedAt: new Date(ts),
        })
        .where(eq(principalState.principalId, principal.id));
      if (preferences.timeZone !== null) {
        await tx
          .update(principals)
          .set({ timeZone: preferences.timeZone, updatedAt: new Date(ts) })
          .where(eq(principals.id, principal.id));
      }
    }
    await new LedgerWriter(db).append(
      {
        ts,
        actor: ONBOARDING_PREFILL_ACTOR,
        kind: 'state_changed',
        sourceSystem: 'graph',
        correlationId: newUlid(),
        payload: { change: ONBOARDING_CHANGES.mailboxSettingsRead, ...preferences, applied },
      },
      tx,
    );
    return applied;
  });
}

/** One sweep over every onboarding principal. */
export async function runOnboardingPrefill(options: PrefillOptions): Promise<PrefillResult> {
  const clock = options.now ?? nowIso;
  const log =
    options.log ??
    ((entry: Record<string, unknown>, message: string) => {
      console.warn(entry, message);
    });
  const onboarding = await options.root
    .select()
    .from(principals)
    .where(eq(principals.status, 'onboarding'));
  const result: PrefillResult = { read: [], failed: [] };
  for (const principal of onboarding) {
    const db = scopedDb(options.root, { principalId: principal.id });
    if (!(await needsRead(db))) continue;
    try {
      const bundle = await options.connectorsFor(principal, db);
      const graph = bundle?.graph ?? null;
      if (graph === null) {
        log(
          { principalId: principal.id },
          "mailbox settings not read: this process has no Graph connector for the principal, whose consent is recorded; check PRINCIPAL_KEY_VAULT_URL and the principal's graph-refresh-token secret",
        );
        result.failed.push(principal.id);
        continue;
      }
      const preferences = preferencesFromMailbox(await graph.reads.getMailboxSettings());
      await store(db, principal, preferences, clock());
      result.read.push(principal.id);
    } catch (error) {
      log(
        { err: error, principalId: principal.id },
        'mailbox settings could not be read for an onboarding principal; the next run tries again, and the principal can enter them by hand meanwhile',
      );
      result.failed.push(principal.id);
    }
  }
  return result;
}
