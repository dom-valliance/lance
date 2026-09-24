import { PRINCIPAL_SECRET_KINDS, principalSecretName, UlidSchema } from '@lance/shared';
import type { CallContext } from '../core/connector.js';
import type { SecretDeleteOutcome, SecretDeleter } from '../secrets/vault.js';
import { createSlackClient, isSlackApiError, type SlackClientOptions } from '../slack/client.js';
import { slackWrites } from '../slack/writes.js';

/**
 * The two writes offboarding makes to Lance's own infrastructure
 * (docs/runbooks/offboard-principal.md, ADR 0024): deleting a principal's
 * credentials from the principal vault, and archiving their private Slack
 * channel.
 *
 * Why these are not connector writes under policy (non-negotiable 2): they
 * do not act on anyone's behalf in an external system. The vault and the
 * bot's own channels are Lance's infrastructure, in the same sense as the
 * Slack surface of ADR 0012. No model reaches this module: its only
 * callers are the worker's offboarding step, started by a `Lance.Admin`
 * from the admin page or by the nightly role check, both deterministic
 * code. Each function is narrow on purpose: the purger deletes exactly the
 * three names ADR 0022 gives one principal, and the archiver refuses any
 * channel it is told to protect, which always includes `dom-claude-agent`.
 */

export interface SecretPurgeResult {
  name: string;
  outcome: SecretDeleteOutcome;
}

export interface PrincipalSecretPurger {
  /** Deletes every per-principal secret of `principalId`. Repeating it finds them absent. */
  purge(principalId: string): Promise<SecretPurgeResult[]>;
}

export function createPrincipalSecretPurger(vault: SecretDeleter): PrincipalSecretPurger {
  return {
    async purge(principalId) {
      const id = UlidSchema.parse(principalId);
      const results: SecretPurgeResult[] = [];
      for (const kind of PRINCIPAL_SECRET_KINDS) {
        const name = principalSecretName(kind, id);
        results.push({ name, outcome: await vault.delete(name) });
      }
      return results;
    },
  };
}

/** Refused because the channel is on the protected list; nothing was sent to Slack. */
export class ProtectedChannelError extends Error {
  override readonly name = 'ProtectedChannelError';
}

export type ChannelArchiveOutcome = 'archived' | 'already_archived' | 'not_found';

export interface SlackChannelArchiver {
  archive(channelId: string, context?: CallContext): Promise<ChannelArchiveOutcome>;
}

export interface SlackChannelArchiverOptions extends SlackClientOptions {
  /**
   * Channels that are never archived, whatever the caller asks: at least
   * `config.slack.channelId`, which is `dom-claude-agent` (ADR 0023).
   */
  protectedChannelIds: readonly string[];
}

export function createSlackChannelArchiver(
  options: SlackChannelArchiverOptions,
): SlackChannelArchiver {
  const writes = slackWrites(createSlackClient(options));
  const protectedIds = new Set(options.protectedChannelIds.filter((id) => id !== ''));
  if (protectedIds.size === 0) {
    throw new Error(
      'The Slack channel archiver needs at least one protected channel id. Pass config.slack.channelId so dom-claude-agent can never be archived.',
    );
  }
  return {
    async archive(channelId, context) {
      if (protectedIds.has(channelId)) {
        throw new ProtectedChannelError(
          `Channel ${channelId} is protected and is never archived by offboarding. It is Lance's shared channel (ADR 0023); remove the principal from it by hand if that is what is needed.`,
        );
      }
      try {
        return await writes.archiveChannel({ channel: channelId }, context);
      } catch (error) {
        // Deleted by hand, or the bot was removed from it: either way
        // nothing of Lance's is left posting there.
        if (isSlackApiError(error, 'channel_not_found')) return 'not_found';
        throw error;
      }
    },
  };
}
