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

/** Channel history for the agent-logs watcher (spec 7.1). Reads only. */
export function slackReads(client: SlackClient) {
  return {
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
