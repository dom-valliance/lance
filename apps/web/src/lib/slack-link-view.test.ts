import { describe, expect, it } from 'vitest';
import { outcomeMessage, previewMessage } from './slack-link-view';

describe('the Slack link page', () => {
  it('names the Slack account before the person confirms', () => {
    const message = previewMessage(
      {
        status: 'ready',
        slackUserId: 'U0TAREK',
        slackTeamId: 'T0VALLIANCE',
        slackName: 'Tarek Example',
        expiresAt: '2026-09-24T10:05:00.000Z',
        alreadyLinked: false,
      },
      null,
      'Lance',
    );
    expect(message.heading).toBe('Link your Slack account');
    expect(message.body).toContain('Tarek Example (U0TAREK)');
    expect(message.body).toContain('Link it only if it is yours.');
  });

  it('shows the standing link when the link was used by this person', () => {
    const message = previewMessage(
      { status: 'used' },
      {
        slackUserId: 'U0TAREK',
        slackTeamId: 'T0VALLIANCE',
        linkedAt: '2026-09-24T10:01:00.000Z',
        channelId: 'G0TAREK',
      },
      'Lance',
    );
    expect(message).toMatchObject({ heading: 'Slack is linked', tone: 'success' });
    expect(message.body).toContain('G0TAREK');
  });

  it('asks for a new link when this one has expired', () => {
    expect(previewMessage({ status: 'expired' }, null, 'Lance').body).toContain('/lance login');
  });

  it('says a new private channel was created', () => {
    const message = outcomeMessage(
      {
        status: 'linked',
        slackUserId: 'U0TAREK',
        slackTeamId: 'T0VALLIANCE',
        channel: { status: 'ready', channelId: 'G0TAREK', name: 'lance-tarek', created: true },
        warnings: [],
      },
      'Lance',
    );
    expect(message.body).toContain('#lance-tarek');
    expect(message.tone).toBe('success');
  });

  it('keeps the link and says how to retry when the channel failed', () => {
    const message = outcomeMessage(
      {
        status: 'linked',
        slackUserId: 'U0TAREK',
        slackTeamId: 'T0VALLIANCE',
        channel: { status: 'failed', reason: 'Slack refused. Run /lance login again.' },
        warnings: [],
      },
      'Lance',
    );
    expect(message).toMatchObject({ heading: 'Slack is linked', tone: 'failure' });
    expect(message.body).toContain('Run /lance login again.');
  });

  it('refuses a Slack account that belongs to someone else', () => {
    expect(outcomeMessage({ status: 'taken' }, 'Lance').heading).toBe(
      'This Slack account is linked to someone else',
    );
  });
});
