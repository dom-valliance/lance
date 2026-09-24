import { principalState, principals, scopedDb, slackLinks, type Db } from '@lance/db';
import {
  LedgerWriter,
  ONBOARDING_ACTOR,
  ONBOARDING_CHANGES,
  latestStateChanges,
  type OnboardingChange,
  type StateChangeEvent,
} from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { PrincipalRef, PrincipalStatus } from '../deps.js';
import { HttpError } from '../errors.js';

/**
 * The onboarding checklist (docs/plans/multi-user.md M3, package 5.5). A
 * principal in status `onboarding` works through five required steps; each
 * is idempotent, reads its state from the server and records a
 * `state_changed` event in the principal's own ledger when it completes.
 *
 * Where each step's state comes from:
 *
 * 1. Notice: the newest `notice_accepted` event and the SHA-256 it names.
 *    The web app holds the notice and passes its hash, so a changed notice
 *    reads as not accepted and asks again.
 * 2. Microsoft 365: the `graph_connected` event the consent callback writes
 *    after it stores `graph-refresh-token--<id>`. The api holds only the
 *    write-only role on the principal vault (ADR 0022) and never learns
 *    from Key Vault whether a secret exists, so the ledger is how it knows.
 * 3. Jamie: the `jamie_connected` event `POST /credentials/jamie` writes
 *    after its test call and the store, for the same reason.
 * 4. Foundry: arrives in Phase 7 and is not required.
 * 5. Slack: an active row in `slack_links` for the principal.
 * 6. Quiet hours and time zone: a `preferences_confirmed` event. The values
 *    are prefilled from the principal's mailbox settings, which the worker
 *    reads once Microsoft 365 is connected (`mailbox_settings_read`).
 *
 * Completion is a narrow system action: every step is checked again here,
 * inside the transaction that changes the status, through an admin scope
 * held to the principal being activated. Migration 0012's guard refuses a
 * status change from any other scope, so a principal cannot mark
 * themselves active by a direct write, and migration 0016's requires the
 * activation time in the same update.
 */

export const REQUIRED_STEPS = ['notice', 'graph', 'jamie', 'slack', 'preferences'] as const;
export type RequiredStep = (typeof REQUIRED_STEPS)[number];

/** How each missing step is named when completion is refused. */
const STEP_ADVICE: Record<RequiredStep, string> = {
  notice: 'accept the data-processing notice',
  graph: 'connect Microsoft 365',
  jamie: 'add your Jamie API key',
  slack: 'link Slack with /lance login',
  preferences: 'confirm your quiet hours and time zone',
};

/** Where the quiet hours and time zone the page shows came from. */
export type PreferencesSource =
  /** Read from the principal's mailbox settings by the worker. */
  | 'mailbox'
  /** Microsoft 365 is connected and the worker has not read the settings yet. */
  | 'waiting_for_mailbox'
  /** The defaults: Microsoft 365 is not connected yet. */
  | 'defaults'
  /** What the principal confirmed. */
  | 'confirmed';

export interface OnboardingState {
  status: PrincipalStatus;
  notice: {
    done: boolean;
    acceptedAt: string | null;
    /** True when a different notice was accepted before: the principal is asked again. */
    changedSinceAcceptance: boolean;
  };
  graph: { done: boolean; connectedAt: string | null };
  jamie: { done: boolean; connectedAt: string | null };
  foundry: { required: false; arrivesLater: true };
  slack: { done: boolean; linkedAt: string | null };
  preferences: {
    done: boolean;
    confirmedAt: string | null;
    timeZone: string;
    quietHoursStart: string;
    quietHoursEnd: string;
    source: PreferencesSource;
  };
  /** The required steps not done yet, in checklist order. */
  missing: RequiredStep[];
}

export interface PreferencesInput {
  timeZone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export type CompletionResult =
  | { status: 'activated'; activatedAt: string; eventId: string }
  /** Already active; nothing was changed. */
  | { status: 'already_active' };

export interface OnboardingServiceLike {
  state(principal: PrincipalRef, noticeSha256: string): Promise<OnboardingState>;
  acceptNotice(principal: PrincipalRef, noticeSha256: string, actor: string): Promise<void>;
  confirmPreferences(
    principal: PrincipalRef,
    input: PreferencesInput,
    actor: string,
  ): Promise<void>;
  complete(principal: PrincipalRef, noticeSha256: string): Promise<CompletionResult>;
}

/** 409: a step is missing, or the principal is not onboarding. The message says what to do. */
export class OnboardingRefusedError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = 'OnboardingRefusedError';
  }
}

export interface OnboardingServiceOptions {
  /** Unscoped; every read and write takes a handle scoped to the principal. */
  root: Db;
  /** Asks the worker to reconcile schedules, so an activated principal's jobs start within seconds. */
  afterActivation?: (principalId: string) => Promise<void>;
  /** Injected in tests. Returns an ISO-8601 instant. */
  now?: () => string;
}

/** Defaults the page shows before anything better is known, as `principal_state` declares them. */
const DEFAULT_QUIET_HOURS = { quietHoursStart: '19:00', quietHoursEnd: '07:00' };

const STEP_CHANGES: readonly OnboardingChange[] = [
  ONBOARDING_CHANGES.noticeAccepted,
  ONBOARDING_CHANGES.graphConnected,
  ONBOARDING_CHANGES.jamieConnected,
  ONBOARDING_CHANGES.mailboxSettingsRead,
  ONBOARDING_CHANGES.preferencesConfirmed,
];

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const iso = (event: StateChangeEvent | undefined): string | null =>
  event === undefined ? null : event.ts.toISOString();

const payloadString = (event: StateChangeEvent | undefined, key: string): string | null => {
  const value = event?.payload?.[key];
  return typeof value === 'string' ? value : null;
};

/** Reads every step in the executor's scope, which must be the principal's. */
async function readState(
  executor: Executor,
  principalId: string,
  noticeSha256: string,
): Promise<OnboardingState> {
  const events = await latestStateChanges(executor, STEP_CHANGES);
  const principalRows = await executor
    .select({ status: principals.status, timeZone: principals.timeZone })
    .from(principals)
    .where(eq(principals.id, principalId))
    .limit(1);
  const principal = principalRows[0];
  if (principal === undefined) {
    throw new Error(
      `Principal ${principalId} is not in the principals table; the caller was resolved from a row that no longer exists.`,
    );
  }
  const stateRows = await executor
    .select({
      quietHoursStart: principalState.quietHoursStart,
      quietHoursEnd: principalState.quietHoursEnd,
    })
    .from(principalState)
    .limit(1);
  const links = await executor
    .select({ linkedAt: slackLinks.linkedAt })
    .from(slackLinks)
    .where(and(eq(slackLinks.principalId, principalId), isNull(slackLinks.revokedAt)))
    .limit(1);

  const accepted = events.get(ONBOARDING_CHANGES.noticeAccepted);
  const acceptedSha256 = payloadString(accepted, 'noticeSha256');
  const noticeDone = acceptedSha256 !== null && acceptedSha256 === noticeSha256;
  const graph = events.get(ONBOARDING_CHANGES.graphConnected);
  const jamie = events.get(ONBOARDING_CHANGES.jamieConnected);
  const mailbox = events.get(ONBOARDING_CHANGES.mailboxSettingsRead);
  const confirmed = events.get(ONBOARDING_CHANGES.preferencesConfirmed);
  const link = links[0];

  const source: PreferencesSource =
    confirmed !== undefined
      ? 'confirmed'
      : mailbox !== undefined
        ? 'mailbox'
        : graph !== undefined
          ? 'waiting_for_mailbox'
          : 'defaults';

  const state: Omit<OnboardingState, 'missing'> = {
    status: principal.status,
    notice: {
      done: noticeDone,
      acceptedAt: noticeDone ? iso(accepted) : null,
      changedSinceAcceptance: acceptedSha256 !== null && !noticeDone,
    },
    graph: { done: graph !== undefined, connectedAt: iso(graph) },
    jamie: { done: jamie !== undefined, connectedAt: iso(jamie) },
    foundry: { required: false, arrivesLater: true },
    slack: { done: link !== undefined, linkedAt: link?.linkedAt.toISOString() ?? null },
    preferences: {
      done: confirmed !== undefined,
      confirmedAt: iso(confirmed),
      timeZone: principal.timeZone,
      ...(stateRows[0] ?? DEFAULT_QUIET_HOURS),
      source,
    },
  };
  const missing = REQUIRED_STEPS.filter((step) => !state[step].done);
  return { ...state, missing };
}

/** A principal who is not onboarding may not change an onboarding step. */
function assertOnboarding(status: PrincipalStatus): void {
  if (status === 'onboarding') return;
  throw new OnboardingRefusedError(
    status === 'active'
      ? 'Onboarding is already complete for this account. Nothing was changed; open Lance to carry on.'
      : `This account is ${status}, so onboarding cannot change. Ask a Lance admin.`,
  );
}

export function createOnboardingService(options: OnboardingServiceOptions): OnboardingServiceLike {
  const clock = options.now ?? nowIso;
  const own = (principalId: string): Db => scopedDb(options.root, { principalId });

  return {
    state: (principal, noticeSha256) => readState(own(principal.id), principal.id, noticeSha256),

    async acceptNotice(principal, noticeSha256, actor) {
      assertOnboarding(principal.status);
      const db = own(principal.id);
      // One acceptance per notice: accepting the same text twice is a no-op,
      // and a changed notice gets an event of its own.
      await new LedgerWriter(db).append({
        ts: clock(),
        actor,
        kind: 'state_changed',
        sourceSystem: 'lance',
        correlationId: newUlid(),
        idempotencyKey: `onboarding:notice:${noticeSha256}`,
        payload: { change: ONBOARDING_CHANGES.noticeAccepted, noticeSha256 },
      });
    },

    async confirmPreferences(principal, input, actor) {
      assertOnboarding(principal.status);
      const db = own(principal.id);
      await db.transaction(async (tx) => {
        const before = await readState(tx, principal.id, '');
        const unchanged =
          before.preferences.done &&
          before.preferences.timeZone === input.timeZone &&
          before.preferences.quietHoursStart === input.quietHoursStart &&
          before.preferences.quietHoursEnd === input.quietHoursEnd;
        if (unchanged) return;
        const ts = clock();
        // The row is the principal's own, created in their scope if absent.
        await tx.insert(principalState).values({}).onConflictDoNothing();
        await tx
          .update(principalState)
          .set({
            quietHoursStart: input.quietHoursStart,
            quietHoursEnd: input.quietHoursEnd,
            updatedAt: new Date(ts),
          })
          .where(eq(principalState.principalId, principal.id));
        await tx
          .update(principals)
          .set({ timeZone: input.timeZone, updatedAt: new Date(ts) })
          .where(eq(principals.id, principal.id));
        await new LedgerWriter(db).append(
          {
            ts,
            actor,
            kind: 'state_changed',
            sourceSystem: 'lance',
            correlationId: newUlid(),
            payload: { change: ONBOARDING_CHANGES.preferencesConfirmed, ...input },
          },
          tx,
        );
      });
    },

    async complete(principal, noticeSha256) {
      if (principal.status === 'active') return { status: 'already_active' };
      assertOnboarding(principal.status);
      // The admin scope is held to this principal: app.principal is theirs,
      // so every read below sees their rows and nobody else's, and the one
      // thing the admin role adds is the status write.
      const system = scopedDb(options.root, { principalId: principal.id, admin: true });
      const result = await system.transaction(async (tx): Promise<CompletionResult> => {
        const state = await readState(tx, principal.id, noticeSha256);
        if (state.status === 'active') return { status: 'already_active' };
        if (state.missing.length > 0) {
          throw new OnboardingRefusedError(
            `Onboarding is not finished: ${state.missing.map((step) => STEP_ADVICE[step]).join(', ')}. Nothing was changed.`,
          );
        }
        const ts = clock();
        const activatedAt = new Date(ts);
        const moved = await tx
          .update(principals)
          .set({ status: 'active', activatedAt, updatedAt: activatedAt })
          .where(and(eq(principals.id, principal.id), eq(principals.status, 'onboarding')))
          .returning({ id: principals.id });
        if (moved.length === 0) return { status: 'already_active' };
        // Run state in the principal's own scope, starting in dry run.
        await tx.insert(principalState).values({}).onConflictDoNothing();
        await tx
          .update(principalState)
          .set({ mode: 'dry_run', updatedAt: activatedAt })
          .where(eq(principalState.principalId, principal.id));
        const event = await new LedgerWriter(system).append(
          {
            ts,
            actor: ONBOARDING_ACTOR,
            kind: 'state_changed',
            sourceSystem: 'lance',
            correlationId: newUlid(),
            payload: {
              change: ONBOARDING_CHANGES.completed,
              from: 'onboarding',
              to: 'active',
              mode: 'dry_run',
              noticeSha256,
            },
          },
          tx,
        );
        return { status: 'activated', activatedAt: activatedAt.toISOString(), eventId: event.id };
      });
      if (result.status === 'activated' && options.afterActivation !== undefined) {
        // The reconciler runs every minute anyway; asking now only saves the wait.
        await options.afterActivation(principal.id).catch((error: unknown) => {
          console.warn(
            { err: error, principalId: principal.id },
            'the worker was not asked to reconcile after an activation; it will within a minute',
          );
        });
      }
      return result;
    },
  };
}
