import type { CallContext } from '../core/connector.js';
import { createSlackClient, type SlackClient, type SlackClientOptions } from './client.js';
import { slackWrites } from './writes.js';

export interface SlackSurfaceOptions extends SlackClientOptions {
  /** Lance's own channel. Every post goes here; nothing else is reachable. */
  channelId: string;
}

/**
 * How Lance speaks in its own channel (ADR 0012): cards, updates, modals and
 * ephemeral replies, pinned to one channel and the bot token. This is a
 * surface for the worker and the api, not a connector write policy governs.
 */
export function createSlackSurface(options: SlackSurfaceOptions) {
  const client: SlackClient = createSlackClient(options);
  const writes = slackWrites(client);
  const channel = options.channelId;
  return {
    channelId: channel,
    connector: client.connector,
    post: (input: { text: string; blocks?: unknown[]; threadTs?: string }, context?: CallContext) =>
      writes.postMessage({ channel, ...input }, context),
    update: (input: { ts: string; text: string; blocks?: unknown[] }, context?: CallContext) =>
      writes.updateMessage({ channel, ...input }, context),
    ephemeral: (input: { user: string; text: string; blocks?: unknown[] }, context?: CallContext) =>
      writes.postEphemeral({ channel, ...input }, context),
    openView: (input: { triggerId: string; view: unknown }, context?: CallContext) =>
      writes.openView(input, context),
  };
}

export type SlackSurface = ReturnType<typeof createSlackSurface>;
