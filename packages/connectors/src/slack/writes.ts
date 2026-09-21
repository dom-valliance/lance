import { z } from 'zod';
import type { CallContext } from '../core/connector.js';
import type { SlackClient } from './client.js';

const PostedSchema = z
  .object({ ok: z.literal(true), channel: z.string(), ts: z.string() })
  .passthrough();
const ViewOpenedSchema = z
  .object({ ok: z.literal(true), view: z.object({ id: z.string() }).passthrough() })
  .passthrough();
const EphemeralSchema = z.object({ ok: z.literal(true), message_ts: z.string() }).passthrough();

export interface PostMessageInput {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

/**
 * The four Slack writes spec 8 allows: post, update, ephemeral, open modal.
 * Lance posts as its own bot user, never as Dom (spec 4.1). Reachable only
 * from the executor and the proposal router through the writes entry point.
 */
export function slackWrites(client: SlackClient) {
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
      const posted = await client.call('write', 'chat.postMessage', body, context, PostedSchema);
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
      const updated = await client.call('write', 'chat.update', body, context, PostedSchema);
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
      const posted = await client.call(
        'write',
        'chat.postEphemeral',
        body,
        context,
        EphemeralSchema,
      );
      return { messageTs: posted.message_ts };
    },
    async openView(
      input: { triggerId: string; view: unknown },
      context?: CallContext,
    ): Promise<{ viewId: string }> {
      const opened = await client.call(
        'write',
        'views.open',
        { trigger_id: input.triggerId, view: input.view },
        context,
        ViewOpenedSchema,
      );
      return { viewId: opened.view.id };
    },
  };
}

export type SlackWrites = ReturnType<typeof slackWrites>;
