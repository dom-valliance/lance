import { isSlackApiError, type SlackChannelProvisioner } from '@lance/connectors';
import { principals, scopedDb, slackLinks, slackLinkTokens, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso, type Config } from '@lance/shared';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { actorFromUpn } from '../actor.js';
import type {
  Caller,
  PrincipalRef,
  SlackChannelOutcome,
  SlackLinkIssue,
  SlackLinkOutcome,
  SlackLinkPreview,
  SlackLinkRefusal,
  SlackLinksLike,
  SlackLinkState,
} from '../deps.js';
import {
  deriveLinkKey,
  linkTokenMatches,
  newLinkNonce,
  parseLinkToken,
  signLinkToken,
} from './link-token.js';

/**
 * `/lance login` (ADR 0021) and the private channel it opens (ADR 0023).
 *
 * `issue` stores a nonce with the Slack ids and returns a link to the web
 * app's `/link/slack` route. The page signs the person in with Entra and
 * calls `preview`, then `confirm`, through tRPC with their token. `confirm`
 * consumes the nonce, so the link works once, and records the binding in
 * `slack_links` in the principal's own scope. Each step writes a ledger
 * event. The database enforces the limits as well (migration 0014).
 */

/**
 * Where Foundry's `slackUserId` for a principal will come from in Phase 7.
 * ADR 0021: a proven link is never made from it and never blocked by it;
 * a disagreement is a warning on the page and in the ledger. There is no
 * directory yet, so the api runs with `noDirectory`.
 */
export interface DirectorySlackIdsLike {
  slackUserIdFor(principal: PrincipalRef): Promise<string | null>;
}

export const noDirectory: DirectorySlackIdsLike = {
  slackUserIdFor: () => Promise.resolve(null),
};

export type ChannelProvisionerLike = Pick<
  SlackChannelProvisioner,
  'userProfile' | 'createPrivateChannel' | 'invite'
>;

export interface SlackLinksOptions {
  /** Unscoped; each write to a principal's rows goes through a handle scoped to them. */
  root: Db;
  config: Pick<Config, 'dom' | 'slack' | 'agentDisplayName'>;
  signingSecret: string;
  /** `PUBLIC_WEB_URL`, the origin the link points at. Null leaves `/lance login` unconfigured. */
  webUrl: string | null;
  /** Null when the api has no bot token: links still work, channels wait. */
  provisioner: ChannelProvisionerLike | null;
  directory?: DirectorySlackIdsLike;
  /** Injected in tests. Returns an ISO-8601 instant with an explicit offset. */
  now?: () => string;
}

/** How many suffixed names to try after `lance-<name>` is taken. */
const MAX_NAME_SUFFIX = 9;
/** Slack channel names: lower case letters, digits, hyphens and underscores, 80 at most. */
const CHANNEL_NAME_MAX = 80;

/**
 * `lance-<first name>` in the form Slack accepts: lower case, accents
 * dropped, anything else a hyphen. The first name comes from Slack's
 * profile, or the UPN's local part up to its first dot.
 */
export const channelBaseName = (firstName: string | null, upn: string): string => {
  const fromUpn = (upn.split('@')[0] ?? '').split('.')[0] ?? '';
  const raw = firstName !== null && firstName.trim() !== '' ? firstName : fromUpn;
  const slug = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `lance-${slug === '' ? 'principal' : slug}`.slice(0, CHANNEL_NAME_MAX - 3);
};

const channelNames = (base: string): string[] => [
  base,
  ...Array.from({ length: MAX_NAME_SUFFIX - 1 }, (_, index) => `${base}-${String(index + 2)}`),
];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface TokenRow {
  nonce: string;
  slackUserId: string;
  slackTeamId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

type Checked = { status: 'ok'; row: TokenRow } | { status: SlackLinkRefusal };

export function createSlackLinks(options: SlackLinksOptions): SlackLinksLike {
  const { root, config } = options;
  const clock = options.now ?? nowIso;
  const key = deriveLinkKey(options.signingSecret);
  const directory = options.directory ?? noDirectory;

  const scoped = (principalId: string): Db => scopedDb(root, { principalId });

  const record = async (
    principalId: string,
    actor: string,
    kind: 'state_changed' | 'failed',
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await new LedgerWriter(scoped(principalId)).append({
      ts: clock(),
      actor,
      kind,
      sourceSystem: 'slack',
      correlationId: newUlid(),
      payload,
    });
  };

  /** The token's row, once its shape and MAC hold; the refusal otherwise. */
  const check = async (token: string): Promise<Checked> => {
    const parsed = parseLinkToken(token);
    if (parsed === null) return { status: 'invalid' };
    const rows = await root
      .select({
        nonce: slackLinkTokens.nonce,
        slackUserId: slackLinkTokens.slackUserId,
        slackTeamId: slackLinkTokens.slackTeamId,
        expiresAt: slackLinkTokens.expiresAt,
        usedAt: slackLinkTokens.usedAt,
      })
      .from(slackLinkTokens)
      .where(eq(slackLinkTokens.nonce, parsed.nonce));
    const row = rows[0];
    if (row === undefined) return { status: 'invalid' };
    if (Math.floor(row.expiresAt.getTime() / 1000) !== parsed.expiresAtSeconds) {
      return { status: 'invalid' };
    }
    if (!linkTokenMatches(key, parsed, row)) return { status: 'invalid' };
    if (row.usedAt !== null) return { status: 'used' };
    if (row.expiresAt.getTime() <= new Date(clock()).getTime()) return { status: 'expired' };
    return { status: 'ok', row };
  };

  const linkOf = async (slackUserId: string) => {
    const rows = await root
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.slackUserId, slackUserId));
    return rows[0] ?? null;
  };

  const channelOf = async (principalId: string): Promise<string | null> => {
    const rows = await root
      .select({ slackChannelId: principals.slackChannelId })
      .from(principals)
      .where(eq(principals.id, principalId));
    return rows[0]?.slackChannelId ?? null;
  };

  const setChannel = async (principalId: string, channelId: string): Promise<void> => {
    await scoped(principalId)
      .update(principals)
      .set({ slackChannelId: channelId, updatedAt: new Date(clock()) })
      .where(and(eq(principals.id, principalId), isNull(principals.slackChannelId)));
  };

  const isDom = (principal: PrincipalRef): boolean =>
    principal.upn.toLowerCase() === config.dom.email.toLowerCase();

  /** Invites into an existing channel, which Slack treats as done when they are in it. */
  const inviteQuietly = async (channelId: string, slackUserId: string): Promise<string | null> => {
    if (options.provisioner === null) return null;
    try {
      await options.provisioner.invite({ channel: channelId, user: slackUserId });
      return null;
    } catch (error) {
      return `${config.agentDisplayName} could not add you to its channel (${errorText(error)}). Ask a Lance admin to invite you.`;
    }
  };

  /**
   * The principal's private channel: kept when they have one, Dom's
   * `dom-claude-agent` for Dom, otherwise created as `lance-<first-name>`
   * with a suffix when the name is taken.
   */
  const ensureChannel = async (
    principal: PrincipalRef,
    slackUserId: string,
    actor: string,
  ): Promise<{ channel: SlackChannelOutcome; warning: string | null }> => {
    const existing = await channelOf(principal.id);
    if (existing !== null) {
      return {
        channel: { status: 'ready', channelId: existing, name: null, created: false },
        warning: await inviteQuietly(existing, slackUserId),
      };
    }

    if (isDom(principal)) {
      await setChannel(principal.id, config.slack.channelId);
      await record(principal.id, actor, 'state_changed', {
        change: 'slack_channel_assigned',
        channelId: config.slack.channelId,
      });
      return {
        channel: {
          status: 'ready',
          channelId: config.slack.channelId,
          name: null,
          created: false,
        },
        warning: null,
      };
    }

    if (options.provisioner === null) {
      return {
        channel: {
          status: 'unavailable',
          reason:
            'The api has no Slack bot token, so your private channel was not created. Run /lance login again once a Lance admin has configured it.',
        },
        warning: null,
      };
    }

    const provisioner = options.provisioner;
    const profile = await provisioner.userProfile(slackUserId).catch(() => null);
    const base = channelBaseName(profile?.firstName ?? null, principal.upn);
    for (const name of channelNames(base)) {
      try {
        const created = await provisioner.createPrivateChannel({ name });
        await record(principal.id, actor, 'state_changed', {
          change: 'slack_channel_created',
          channelId: created.id,
          name: created.name,
        });
        await provisioner.invite({ channel: created.id, user: slackUserId });
        await record(principal.id, actor, 'state_changed', {
          change: 'slack_channel_invited',
          channelId: created.id,
          slackUserId,
        });
        await setChannel(principal.id, created.id);
        return {
          channel: { status: 'ready', channelId: created.id, name: created.name, created: true },
          warning: null,
        };
      } catch (error) {
        if (isSlackApiError(error, 'name_taken')) continue;
        await record(principal.id, actor, 'failed', {
          change: 'slack_channel_failed',
          name,
          error: errorText(error),
        });
        return {
          channel: {
            status: 'failed',
            reason: `Slack refused to create your private channel (${errorText(error)}). Your account is linked; run /lance login again to retry the channel.`,
          },
          warning: null,
        };
      }
    }
    await record(principal.id, actor, 'failed', {
      change: 'slack_channel_failed',
      name: base,
      error: 'every candidate name is taken',
    });
    return {
      channel: {
        status: 'failed',
        reason: `Every channel name from ${base} to ${base}-${String(MAX_NAME_SUFFIX)} is taken in Slack. Ask a Lance admin to free one, then run /lance login again.`,
      },
      warning: null,
    };
  };

  return {
    async issue(input): Promise<SlackLinkIssue> {
      if (options.webUrl === null) return { status: 'unconfigured' };
      const nonce = newLinkNonce();
      // The database's clock sets the expiry, so the policy's five-minute
      // bound and the token always agree.
      const inserted = await root.execute<{ expires_at: string | Date }>(
        sql`INSERT INTO slack_link_tokens (nonce, slack_user_id, slack_team_id, expires_at)
            VALUES (${nonce}, ${input.slackUserId}, ${input.slackTeamId}, date_trunc('second', now()) + interval '5 minutes')
            RETURNING expires_at`,
      );
      const expiresRaw = inserted.rows[0]?.expires_at;
      if (expiresRaw === undefined) {
        throw new Error('The link nonce was stored and its expiry could not be read back.');
      }
      const expiresAt = new Date(expiresRaw);
      await root.execute(sql`DELETE FROM slack_link_tokens WHERE expires_at < now()`);
      const token = signLinkToken(key, {
        slackUserId: input.slackUserId,
        slackTeamId: input.slackTeamId,
        nonce,
        expiresAtSeconds: Math.floor(expiresAt.getTime() / 1000),
      });
      await record(input.recordFor.id, input.actor, 'state_changed', {
        change: 'slack_link_issued',
        slackUserId: input.slackUserId,
        slackTeamId: input.slackTeamId,
        expiresAt: expiresAt.toISOString(),
      });
      const url = new URL('/link/slack', options.webUrl);
      url.searchParams.set('state', token);
      return { status: 'issued', url: url.toString(), expiresAt: expiresAt.toISOString() };
    },

    async preview(token, principal): Promise<SlackLinkPreview> {
      const checked = await check(token);
      if (checked.status !== 'ok') return { status: checked.status };
      const { row } = checked;
      const existing = await linkOf(row.slackUserId);
      if (existing !== null && existing.principalId !== principal.id) return { status: 'taken' };
      const profile =
        options.provisioner === null
          ? null
          : await options.provisioner.userProfile(row.slackUserId).catch(() => null);
      return {
        status: 'ready',
        slackUserId: row.slackUserId,
        slackTeamId: row.slackTeamId,
        slackName: profile?.displayName ?? null,
        expiresAt: row.expiresAt.toISOString(),
        alreadyLinked: existing !== null && existing.revokedAt === null,
      };
    },

    async confirm(token, caller: Caller): Promise<SlackLinkOutcome> {
      const { principal, identity } = caller;
      if (principal.status === 'paused' || principal.status === 'offboarded') {
        return { status: 'inactive' };
      }
      const checked = await check(token);
      if (checked.status !== 'ok') return { status: checked.status };
      const { row } = checked;
      const existing = await linkOf(row.slackUserId);
      if (existing !== null && existing.principalId !== principal.id) return { status: 'taken' };

      const consumed = await root
        .update(slackLinkTokens)
        .set({ usedAt: sql`now()` })
        .where(and(eq(slackLinkTokens.nonce, row.nonce), isNull(slackLinkTokens.usedAt)))
        .returning({ nonce: slackLinkTokens.nonce });
      if (consumed.length === 0) {
        const again = await check(token);
        return { status: again.status === 'ok' ? 'used' : again.status };
      }

      const actor = actorFromUpn(identity.upn);
      const db = scoped(principal.id);
      const at = new Date(clock());
      const replaced = await db
        .update(slackLinks)
        .set({ revokedAt: at })
        .where(
          and(
            eq(slackLinks.principalId, principal.id),
            isNull(slackLinks.revokedAt),
            ne(slackLinks.slackUserId, row.slackUserId),
          ),
        )
        .returning({ slackUserId: slackLinks.slackUserId });
      if (existing === null) {
        await db.execute(
          sql`INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id, linked_at)
              VALUES (${row.slackUserId}, ${row.slackTeamId}, ${principal.id}, ${at.toISOString()})`,
        );
      } else {
        await db
          .update(slackLinks)
          .set({ linkedAt: at, revokedAt: null })
          .where(eq(slackLinks.slackUserId, row.slackUserId));
      }

      const roles = [...identity.roles].sort();
      await db
        .update(principals)
        .set({ lanceRoles: roles, rolesRecordedAt: at, updatedAt: at })
        .where(eq(principals.id, principal.id));

      const warnings: string[] = [];
      const fromDirectory = await directory.slackUserIdFor(principal);
      if (fromDirectory !== null && fromDirectory !== row.slackUserId) {
        warnings.push(
          `The staff directory lists a different Slack account for you (${fromDirectory}). The link you proved stands; tell a Lance admin so the directory can be corrected.`,
        );
      }

      await record(principal.id, actor, 'state_changed', {
        change: 'slack_linked',
        slackUserId: row.slackUserId,
        slackTeamId: row.slackTeamId,
        replacedSlackUserIds: replaced.map((link) => link.slackUserId),
        roles,
        directorySlackUserId: fromDirectory,
      });

      const { channel, warning } = await ensureChannel(principal, row.slackUserId, actor);
      if (warning !== null) warnings.push(warning);
      return {
        status: 'linked',
        slackUserId: row.slackUserId,
        slackTeamId: row.slackTeamId,
        channel,
        warnings,
      };
    },

    async current(principal): Promise<SlackLinkState | null> {
      const rows = await root
        .select()
        .from(slackLinks)
        .where(and(eq(slackLinks.principalId, principal.id), isNull(slackLinks.revokedAt)));
      const link = rows[0];
      if (link === undefined) return null;
      return {
        slackUserId: link.slackUserId,
        slackTeamId: link.slackTeamId,
        linkedAt: link.linkedAt.toISOString(),
        channelId: await channelOf(principal.id),
      };
    },
  };
}
