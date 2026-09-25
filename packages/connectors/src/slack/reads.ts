import { z } from 'zod';
import type { SlackClient } from './client.js';

export const SlackMessageSchema = z
  .object({
    type: z.string(),
    ts: z.string(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
    thread_ts: z.string().optional(),
    subtype: z.string().optional(),
  })
  .passthrough();
export type SlackMessage = z.infer<typeof SlackMessageSchema>;

const HistorySchema = z
  .object({
    messages: z.array(SlackMessageSchema),
    has_more: z.boolean().optional(),
    response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
  })
  .passthrough();

export interface HistoryPage {
  messages: SlackMessage[];
  nextCursor: string | null;
}

const AuthTestSchema = z
  .object({ user_id: z.string(), bot_id: z.string().optional(), team_id: z.string().optional() })
  .passthrough();

const UserInfoSchema = z
  .object({
    user: z
      .object({
        id: z.string(),
        name: z.string().optional(),
        real_name: z.string().optional(),
        profile: z
          .object({
            first_name: z.string().optional(),
            real_name: z.string().optional(),
            display_name: z.string().optional(),
            email: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface SlackUserProfile {
  id: string;
  /** The profile's first name, or null when the person left it blank. */
  firstName: string | null;
  /** The best display name Slack holds: real name, display name, then handle. */
  displayName: string | null;
  /**
   * The profile's email address. Slack returns it only when the bot token
   * holds `users:read.email`; null without that scope or when it is blank.
   */
  email: string | null;
}

const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();

/** Channel history for the agent-logs watcher (spec 7.1). Reads only. */
export function slackReads(client: SlackClient) {
  return {
    /** Who the bot token is: its user id and bot id, so the watcher can skip Lance's own posts. */
    async authTest(): Promise<{ userId: string; botId: string | null; teamId: string | null }> {
      const reply = await client.call('auth.test', {}, {}, AuthTestSchema);
      return { userId: reply.user_id, botId: reply.bot_id ?? null, teamId: reply.team_id ?? null };
    },
    /** `users.info`: a person's names and email, for the link page, the link check and their channel name (ADR 0021, ADR 0023). */
    async userProfile(user: string): Promise<SlackUserProfile> {
      const reply = await client.call('users.info', { user }, {}, UserInfoSchema);
      const profile = reply.user.profile;
      return {
        id: reply.user.id,
        firstName: blankToNull(profile?.first_name),
        displayName:
          blankToNull(profile?.real_name) ??
          blankToNull(reply.user.real_name) ??
          blankToNull(profile?.display_name) ??
          blankToNull(reply.user.name),
        email: blankToNull(profile?.email),
      };
    },
    async conversationsHistory(input: {
      channel: string;
      oldest?: string;
      cursor?: string;
      limit?: number;
    }): Promise<HistoryPage> {
      const body: Record<string, unknown> = { channel: input.channel, limit: input.limit ?? 200 };
      if (input.oldest !== undefined) body['oldest'] = input.oldest;
      if (input.cursor !== undefined) body['cursor'] = input.cursor;
      const page = await client.call('conversations.history', body, {}, HistorySchema);
      const next = page.response_metadata?.next_cursor;
      return {
        messages: page.messages,
        nextCursor: next === undefined || next === '' ? null : next,
      };
    },
    async conversationsReplies(input: {
      channel: string;
      ts: string;
      cursor?: string;
    }): Promise<HistoryPage> {
      const body: Record<string, unknown> = { channel: input.channel, ts: input.ts, limit: 200 };
      if (input.cursor !== undefined) body['cursor'] = input.cursor;
      const page = await client.call('conversations.replies', body, {}, HistorySchema);
      const next = page.response_metadata?.next_cursor;
      return {
        messages: page.messages,
        nextCursor: next === undefined || next === '' ? null : next,
      };
    },
  };
}
