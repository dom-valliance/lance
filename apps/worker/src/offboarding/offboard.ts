import type {
  ChannelArchiveOutcome,
  PrincipalSecretPurger,
  SecretPurgeResult,
  SlackChannelArchiver,
} from '@lance/connectors';
import { principals, principalState, scopedDb, slackLinks, type Db } from '@lance/db';
import { LedgerWriter, SystemControl, type RetentionCounts } from '@lance/ledger';
import { newUlid, nowIso, type Config } from '@lance/shared';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { runRetention } from '../retention/run.js';

/**
 * Offboarding one principal (docs/runbooks/offboard-principal.md,
 * docs/plans/multi-user.md M7), started by a `Lance.Admin` from the admin
 * page or by the nightly role check. The steps run in this order and each
 * is idempotent, so a run that stopped part way is finished by running it
 * again:
 *
 *   1. status     set `offboarded`, through an admin scope
 *   2. pause      pause the principal, which holds their approved proposals
 *   3. secrets    delete their credentials from the principal vault
 *   4. slack      revoke their Slack link and archive their private channel
 *   5. retention  a zero-day run over mail bodies, transcripts and model logs
 *
 * Their ledger rows stay, with payloads nulled as retention reaches them
 * (ADR 0011); nothing here deletes a ledger row. Every step records one
 * `state_changed` event (`change: 'offboarding_step'`) in the principal's
 * own ledger, under one correlation id, naming what it found and did and
 * never a secret value or any content. Steps 3 and 4 write to Lance's own
 * infrastructure through `@lance/connectors`' offboarding module, which is
 * not a connector write under policy and is reachable by no model.
 */

export const OFFBOARD_QUEUE = 'offboard-principal';

export type OffboardingStep =
  'status' | 'pause' | 'secrets' | 'slack_link' | 'slack_channel' | 'retention';

export type StepOutcome = 'done' | 'already_done' | 'skipped' | 'failed';

export interface StepRecord {
  step: OffboardingStep;
  outcome: StepOutcome;
  detail: Record<string, unknown>;
}

export interface OffboardDeps {
  /** Unscoped; every read and write below scopes itself. */
  root: Db;
  config: Pick<Config, 'retention' | 'slack'>;
  /** Null in a process without the principal vault; the step is recorded as skipped. */
  secrets: PrincipalSecretPurger | null;
  /** Null without a Slack bot token; the channel step is recorded as skipped. */
  channels: SlackChannelArchiver | null;
  now?: () => string;
}

export interface OffboardRequest {
  principalId: string;
  /** Who asked: `user:<name>` for an admin, `system:role-check` for the nightly check. */
  actor: string;
  reason: string;
}

export interface OffboardResult {
  principalId: string;
  correlationId: string;
  steps: StepRecord[];
}

/** A principal id that is not in `principals`: the request named the wrong one. */
export class UnknownPrincipalError extends Error {
  override readonly name = 'UnknownPrincipalError';
}

export async function offboardPrincipal(
  deps: OffboardDeps,
  request: OffboardRequest,
): Promise<OffboardResult> {
  const clock = deps.now ?? nowIso;
  const rows = await deps.root
    .select({
      id: principals.id,
      upn: principals.upn,
      status: principals.status,
      slackChannelId: principals.slackChannelId,
    })
    .from(principals)
    .where(eq(principals.id, request.principalId))
    .limit(1);
  const principal = rows[0];
  if (principal === undefined) {
    throw new UnknownPrincipalError(
      `No principal has id ${request.principalId}, so nobody was offboarded. Take the id from the admin page's principals list.`,
    );
  }

  const own = scopedDb(deps.root, { principalId: principal.id });
  const admin = scopedDb(deps.root, { principalId: principal.id, admin: true });
  const writer = new LedgerWriter(admin);
  const correlationId = newUlid();
  const steps: StepRecord[] = [];

  const record = async (entry: StepRecord): Promise<void> => {
    steps.push(entry);
    await writer.append({
      ts: clock(),
      actor: request.actor,
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId,
      payload: {
        change: 'offboarding_step',
        principalId: principal.id,
        step: entry.step,
        outcome: entry.outcome,
        ...entry.detail,
      },
    });
  };

  const step = async (
    name: OffboardingStep,
    work: () => Promise<Omit<StepRecord, 'step'>>,
  ): Promise<void> => {
    let entry: Omit<StepRecord, 'step'>;
    try {
      entry = await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record({ step: name, outcome: 'failed', detail: { error: message } });
      throw new Error(
        `Offboarding ${principal.upn} stopped at the ${name} step: ${message} Every step is idempotent; fix the cause and run the offboarding again.`,
        { cause: error },
      );
    }
    await record({ step: name, ...entry });
  };

  await step('status', async () => {
    const updated = await admin
      .update(principals)
      .set({ status: 'offboarded', updatedAt: new Date(clock()) })
      .where(and(eq(principals.id, principal.id), ne(principals.status, 'offboarded')))
      .returning({ id: principals.id });
    return {
      outcome: updated.length === 0 ? 'already_done' : 'done',
      detail: { from: principal.status, reason: request.reason },
    };
  });

  await step('pause', async () => {
    // A principal who never finished onboarding has no run state yet.
    await own.insert(principalState).values({}).onConflictDoNothing({
      target: principalState.principalId,
    });
    const paused = await new SystemControl(own).pause({
      reason: `Offboarded: ${request.reason}`,
      actor: request.actor,
    });
    return {
      outcome: paused.changed ? 'done' : 'already_done',
      detail: { heldProposalIds: paused.heldProposalIds },
    };
  });

  await step('secrets', async () => {
    if (deps.secrets === null) {
      return {
        outcome: 'skipped',
        detail: { why: 'This process has no principal vault (PRINCIPAL_KEY_VAULT_URL is unset).' },
      };
    }
    const results: SecretPurgeResult[] = await deps.secrets.purge(principal.id);
    return {
      outcome: results.some((result) => result.outcome === 'deleted') ? 'done' : 'already_done',
      detail: {
        secrets: results,
        // Both vaults have purge protection: a deleted secret stays
        // recoverable, soft-deleted, until the vault's retention period ends.
        softDeleted: true,
      },
    };
  });

  await step('slack_link', async () => {
    const revoked = await admin
      .update(slackLinks)
      .set({ revokedAt: new Date(clock()) })
      .where(and(eq(slackLinks.principalId, principal.id), isNull(slackLinks.revokedAt)))
      .returning({ slackUserId: slackLinks.slackUserId });
    return {
      outcome: revoked.length === 0 ? 'already_done' : 'done',
      detail: { revokedLinks: revoked.length },
    };
  });

  await step('slack_channel', async () => {
    const channelId = principal.slackChannelId;
    if (channelId === null) {
      return { outcome: 'skipped', detail: { why: 'The principal has no private channel.' } };
    }
    if (channelId === deps.config.slack.channelId) {
      return {
        outcome: 'skipped',
        detail: { channelId, why: 'This is dom-claude-agent, which offboarding never archives.' },
      };
    }
    if (deps.channels === null) {
      return {
        outcome: 'skipped',
        detail: { channelId, why: 'This process has no Slack bot token (SLACK_BOT_TOKEN).' },
      };
    }
    const archived: ChannelArchiveOutcome = await deps.channels.archive(channelId, {
      correlationId,
    });
    return {
      outcome: archived === 'archived' ? 'done' : 'already_done',
      detail: { channelId, slack: archived },
    };
  });

  await step('retention', async () => {
    const result = await runRetention({
      root: deps.root,
      config: deps.config,
      principalId: principal.id,
      trigger: 'offboarding',
      actor: request.actor,
      now: clock,
    });
    const counts: RetentionCounts = result.counts;
    const total = Object.values(counts).reduce((sum: number, count: number) => sum + count, 0);
    return {
      outcome: total === 0 ? 'already_done' : 'done',
      detail: { counts, retentionEventId: result.eventId },
    };
  });

  return { principalId: principal.id, correlationId, steps };
}
