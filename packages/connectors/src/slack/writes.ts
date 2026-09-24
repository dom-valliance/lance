import { z } from 'zod';
import type { CallContext } from '../core/connector.js';
import { isSlackApiError, slackWriteAccess, type SlackClient } from './client.js';

const PostedSchema = z
  .object({ ok: z.literal(true), channel: z.string(), ts: z.string() })
  .passthrough();
const ViewOpenedSchema = z
  .object({ ok: z.literal(true), view: z.object({ id: z.string() }).passthrough() })
  .passthrough();
const EphemeralSchema = z.object({ ok: z.literal(true), message_ts: z.string() }).passthrough();
const ConversationSchema = z
  .object({
    ok: z.literal(true),
    channel: z.object({ id: z.string(), name: z.string() }).passthrough(),
  })
  .passthrough();

export interface PostMessageInput {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

/**
 * The four Slack writes spec 8 allows: post, update, ephemeral, open modal;
 * and the two that give a principal their private channel (ADR 0023).
 * Lance posts as its own bot user, never as Dom (spec 4.1). Reachable only
 * from the executor and the proposal router through the writes entry point,
 * and the write capability comes from `slackWriteAccess`, which no barrel
 * exports.
 *
 * `chat.update` names the message it edits, so a repeat cannot post a second
 * one and it keeps the full retry policy. The other three create something,
 * so they retry only on 429, where Slack states it refused the request.
 */
export function slackWrites(client: SlackClient) {
  const write = slackWriteAccess(client);
  return {
    async postMessage(
      input: PostMessageInput,
      context?: CallContext,
    ): Promise<{ channel: string; ts: string }> {
      const body: Record<string, unknown> = {
        channel: input.channel,
        text: input.text,
        unfurl_links: false,
      };
      if (input.blocks !== undefined) body['blocks'] = input.blocks;
      if (input.threadTs !== undefined) body['thread_ts'] = input.threadTs;
      const posted = await write('chat.postMessage', body, context, PostedSchema);
      return { channel: posted.channel, ts: posted.ts };
    },
    async updateMessage(
      input: { channel: string; ts: string; text: string; blocks?: unknown[] },
      context?: CallContext,
    ): Promise<{ channel: string; ts: string }> {
      const body: Record<string, unknown> = {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
      };
      if (input.blocks !== undefined) body['blocks'] = input.blocks;
      const updated = await write('chat.update', body, context, PostedSchema, {
        idempotent: true,
      });
      return { channel: updated.channel, ts: updated.ts };
    },
    async postEphemeral(
      input: { channel: string; user: string; text: string; blocks?: unknown[] },
      context?: CallContext,
    ): Promise<{ messageTs: string }> {
      const body: Record<string, unknown> = {
        channel: input.channel,
        user: input.user,
        text: input.text,
      };
      if (input.blocks !== undefined) body['blocks'] = input.blocks;
      const posted = await write('chat.postEphemeral', body, context, EphemeralSchema);
      return { messageTs: posted.message_ts };
    },
    async openView(
      input: { triggerId: string; view: unknown },
      context?: CallContext,
    ): Promise<{ viewId: string }> {
      const opened = await write(
        'views.open',
        { trigger_id: input.triggerId, view: input.view },
        context,
        ViewOpenedSchema,
      );
      return { viewId: opened.view.id };
    },
    /**
     * `conversations.create` with `is_private`. Creating is not idempotent,
     * so it retries only on 429; a taken name fails with `name_taken`.
     */
    async createPrivateChannel(
      input: { name: string },
      context?: CallContext,
    ): Promise<{ id: string; name: string }> {
      const created = await write(
        'conversations.create',
        { name: input.name, is_private: true },
        context,
        ConversationSchema,
      );
      return { id: created.channel.id, name: created.channel.name };
    },
    /** `conversations.invite`. Inviting someone already in the channel is a no-op. */
    async inviteToChannel(
      input: { channel: string; users: string[] },
      context?: CallContext,
    ): Promise<void> {
      try {
        await write(
          'conversations.invite',
          { channel: input.channel, users: input.users.join(',') },
          context,
          undefined,
          { idempotent: true },
        );
      } catch (error) {
        if (isSlackApiError(error, 'already_in_channel')) return;
        throw error;
      }
    },
  };
}

export type SlackWrites = ReturnType<typeof slackWrites>;
