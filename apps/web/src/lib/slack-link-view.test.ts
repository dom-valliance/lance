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

  it('says the link was issued to someone else when the Slack email differs', () => {
    const message = previewMessage({ status: 'email_mismatch' }, null, 'Lance');
    expect(message.heading).toBe('This link was issued to someone else');
    expect(message.body).toContain('Run /lance login from your own Slack account.');
    expect(message.tone).toBe('failure');
  });

  it('names the missing Slack scope when Slack returned no email', () => {
    expect(outcomeMessage({ status: 'email_unavailable' }, 'Lance').body).toContain(
      'users:read.email',
    );
  });

  it('says how to unlink first when the principal is linked to another Slack account', () => {
    const message = outcomeMessage({ status: 'linked_elsewhere' }, 'Lance');
    expect(message.heading).toBe('Your account is linked to another Slack account');
    expect(message.body).toContain('Run /lance unlink from the Slack account linked now');
  });
});
