import type { Principal } from '@lance/db';
import { loadConfig } from '@lance/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { principalSlackSurface } from './connectors.js';

/** Delivery reads the channel from the principal (ADR 0023). */

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/lance' });

const principal = (overrides: Partial<Principal>): Principal => ({
  id: '01K5S9V6QW3SWCCPVB0N0E300H',
  entraOid: null,
  upn: 'dom@valliance.ai',
  slackUserId: null,
  slackChannelId: null,
  notionUserId: null,
  foundryEmployeeId: null,
  timeZone: 'Europe/London',
  status: 'active',
  lanceRoles: [],
  rolesRecordedAt: null,
  createdAt: new Date('2026-09-20T09:00:00.000Z'),
  updatedAt: new Date('2026-09-20T09:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a principal's Slack surface", () => {
  it("posts to each principal's own channel", () => {
    const dom = principalSlackSurface(config, principal({ slackChannelId: 'C0BU7P278N5' }));
    const tarek = principalSlackSurface(
      config,
      principal({
        id: '01K5S9V6QW3SWCCPVB0N0E3T01',
        upn: 'tarek@valliance.ai',
        slackChannelId: 'G0TAREK',
      }),
    );

    expect([dom?.channelId, tarek?.channelId]).toEqual(['C0BU7P278N5', 'G0TAREK']);
  });

  it('keeps Dom on dom-claude-agent until his link records a channel', () => {
    expect(principalSlackSurface(config, principal({}))?.channelId).toBe('C0BU7P278N5');
  });

  it("gives a principal with no channel no surface, rather than Dom's channel", () => {
    expect(principalSlackSurface(config, principal({ upn: 'tarek@valliance.ai' }))).toBeNull();
  });

  it('gives no surface without a bot token', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    expect(principalSlackSurface(config, principal({ slackChannelId: 'G0TAREK' }))).toBeNull();
  });
});
