import type { Config } from './config.js';

/**
 * Where a principal's Slack delivery goes (ADR 0023): proposal cards,
 * alerts, briefs, digests and job output. The channel is read from the
 * principal, never from config, with one exception while Dom has not yet
 * linked: the principal whose UPN is `config.dom.email` keeps
 * `config.slack.channelId`, `dom-claude-agent`, which is also the channel
 * his link records. Anyone else without a channel has nowhere to post and
 * gets null, so nothing of theirs lands in another person's channel.
 */
export const deliveryChannelFor = (
  principal: { readonly upn: string; readonly slackChannelId: string | null },
  config: Pick<Config, 'dom' | 'slack'>,
): string | null => {
  if (principal.slackChannelId !== null) return principal.slackChannelId;
  return principal.upn.toLowerCase() === config.dom.email.toLowerCase()
    ? config.slack.channelId
    : null;
};
