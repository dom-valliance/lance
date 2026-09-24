import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalContext } from './context.js';
import { connectorOfWatcher, type NotConnected } from './connectors.js';
import { recordSkippedWatcherRun } from './handlers.js';

const PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E3C01';

const contextWith = (notConnected: NotConnected[]): PrincipalContext =>
  ({
    principal: { id: PRINCIPAL_ID, upn: 'colleague.two@example.test' },
    connectors: {
      graph: null,
      notion: null,
      jamie: null,
      slack: null,
      agentLogs: null,
      notConnected,
    },
  }) as unknown as PrincipalContext;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectorOfWatcher', () => {
  it('maps every per-principal watcher to the connector it needs', () => {
    expect(connectorOfWatcher('watcher-graph-mail')).toBe('graph');
    expect(connectorOfWatcher('watcher-graph-calendar')).toBe('graph');
    expect(connectorOfWatcher('watcher-jamie')).toBe('jamie');
    expect(connectorOfWatcher('watcher-notion')).toBe('notion');
    expect(connectorOfWatcher('watcher-agent-logs')).toBe('slack');
  });
});

describe('recordSkippedWatcherRun', () => {
  it('records the skip naming the missing secret and keeps the context while it is absent', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const evict = vi.fn();
    const gap: NotConnected = {
      connector: 'jamie',
      missing: `jamie-api-key--${PRINCIPAL_ID}`,
      recheck: () => Promise.resolve(false),
    };

    await recordSkippedWatcherRun(
      { contexts: { evict } as never },
      contextWith([gap]),
      'watcher-jamie',
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'watcher-jamie',
        principalId: PRINCIPAL_ID,
        status: 'skipped',
        connector: 'jamie',
        missing: `jamie-api-key--${PRINCIPAL_ID}`,
      }),
      expect.stringContaining(`jamie-api-key--${PRINCIPAL_ID} is absent`),
    );
    expect(evict).not.toHaveBeenCalled();
  });

  it('drops the context once the secret exists, so the next job builds the connector', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const evict = vi.fn();
    const gap: NotConnected = {
      connector: 'graph',
      missing: `graph-refresh-token--${PRINCIPAL_ID}`,
      recheck: () => Promise.resolve(true),
    };

    await recordSkippedWatcherRun(
      { contexts: { evict } as never },
      contextWith([gap]),
      'watcher-graph-mail',
    );

    expect(evict).toHaveBeenCalledWith(PRINCIPAL_ID);
  });
});
