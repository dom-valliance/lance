import type { ApiClient } from '@/lib/trpc';

/**
 * What the `/link/slack` page says (ADR 0021). The api decides every
 * outcome; this module only words it, so each state is tested without a
 * render. Nothing here reads the URL but the token itself: the page's
 * outcome comes from server state, never from a query string.
 */

export type SlackLinkPreview = Awaited<ReturnType<ApiClient['slackLink']['preview']['query']>>;
export type SlackLinkOutcome = Awaited<ReturnType<ApiClient['slackLink']['confirm']['mutate']>>;
export type SlackLinkState = Awaited<ReturnType<ApiClient['slackLink']['current']['query']>>;

export interface LinkMessage {
  heading: string;
  body: string;
  tone: 'neutral' | 'success' | 'failure';
}

type Refusal = Exclude<SlackLinkPreview['status'], 'ready'>;

const refusal = (status: Refusal, name: string): LinkMessage => {
  switch (status) {
    case 'invalid':
      return {
        heading: 'This link is not valid',
        body: `It may be incomplete, or it was not issued by ${name}. Run /lance login in Slack for a new one.`,
        tone: 'failure',
      };
    case 'expired':
      return {
        heading: 'This link has expired',
        body: 'Links last five minutes. Run /lance login in Slack for a new one.',
        tone: 'failure',
      };
    case 'used':
      return {
        heading: 'This link has been used',
        body: 'Each link works once. Run /lance login in Slack for a new one if you need to link again.',
        tone: 'neutral',
      };
    case 'taken':
      return {
        heading: 'This Slack account is linked to someone else',
        body: `It acts for another ${name} account, so it cannot be linked to yours. Ask a Lance admin if that is wrong. Nothing was changed.`,
        tone: 'failure',
      };
    case 'inactive':
      return {
        heading: 'Your account cannot link Slack now',
        body: `Your ${name} account is paused or offboarded. Ask a Lance admin. Nothing was changed.`,
        tone: 'failure',
      };
    case 'email_mismatch':
      return {
        heading: 'This link was issued to someone else',
        body: `The Slack account that ran /lance login has a different email address from the Microsoft account you signed in with, so ${name} will not link them. Run /lance login from your own Slack account. Nothing was changed.`,
        tone: 'failure',
      };
    case 'email_unavailable':
      return {
        heading: 'Slack did not confirm whose account this is',
        body: `${name} checks that the Slack account's email matches your Microsoft account, and Slack did not return one. Ask a Lance admin to check the Slack app's users:read.email scope. Nothing was changed.`,
        tone: 'failure',
      };
    case 'linked_elsewhere':
      return {
        heading: 'Your account is linked to another Slack account',
        body: `${name} acts for you through one Slack account at a time. Run /lance unlink from the Slack account linked now, then run /lance login again from this one. If you no longer have that account, ask a Lance admin to revoke its link. Nothing was changed.`,
        tone: 'failure',
      };
  }
};

/** The page before the person confirms, or why they cannot. */
export function previewMessage(
  preview: SlackLinkPreview,
  current: SlackLinkState,
  name: string,
): LinkMessage {
  if (preview.status === 'ready') {
    const who =
      preview.slackName === null
        ? preview.slackUserId
        : `${preview.slackName} (${preview.slackUserId})`;
    return {
      heading: preview.alreadyLinked ? 'Link this Slack account again' : 'Link your Slack account',
      body: `Slack account ${who} will act for you in ${name}: it can approve your proposals and run your commands. Link it only if it is yours.`,
      tone: 'neutral',
    };
  }
  if (preview.status === 'used' && current !== null) {
    return {
      heading: 'Slack is linked',
      body: `Slack account ${current.slackUserId} acts for you in ${name}${current.channelId === null ? '.' : `, and your cards arrive in channel ${current.channelId}.`}`,
      tone: 'success',
    };
  }
  return refusal(preview.status, name);
}

/** The page after the person confirmed. */
export function outcomeMessage(outcome: SlackLinkOutcome, name: string): LinkMessage {
  if (outcome.status !== 'linked') return refusal(outcome.status, name);
  const { channel } = outcome;
  const where =
    channel.status === 'ready'
      ? channel.created
        ? ` ${name} created your private channel${channel.name === null ? '' : ` #${channel.name}`}; your proposals, alerts and briefs arrive there.`
        : ` Your proposals, alerts and briefs arrive in channel ${channel.channelId}.`
      : ` ${channel.reason}`;
  return {
    heading: 'Slack is linked',
    body: `Slack account ${outcome.slackUserId} now acts for you in ${name}.${where}`,
    tone: channel.status === 'ready' ? 'success' : 'failure',
  };
}
