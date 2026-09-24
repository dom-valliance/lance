import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { deliveryChannelFor } from './slack.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/lance' });

describe('deliveryChannelFor', () => {
  it("delivers to the principal's own channel", () => {
    expect(
      deliveryChannelFor({ upn: 'tarek@valliance.ai', slackChannelId: 'G0TAREK' }, config),
    ).toBe('G0TAREK');
  });

  it('keeps Dom on dom-claude-agent until his link records a channel', () => {
    expect(deliveryChannelFor({ upn: 'Dom@Valliance.ai', slackChannelId: null }, config)).toBe(
      'C0BU7P278N5',
    );
  });

  it("gives a principal with no channel nowhere to post rather than Dom's channel", () => {
    expect(deliveryChannelFor({ upn: 'tarek@valliance.ai', slackChannelId: null }, config)).toBe(
      null,
    );
  });
});
