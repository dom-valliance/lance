import { describe, expect, it } from 'vitest';
import { shellStatusLine, staleWatchers } from './shell-status';

describe('staleWatchers', () => {
  it('names a watcher whose newest cursor is over an hour old', () => {
    expect(
      staleWatchers([
        { watcher: 'graph-mail', ageMinutes: 4 },
        { watcher: 'jamie', ageMinutes: 300 },
      ]),
    ).toEqual(['Jamie']);
  });

  it('judges a watcher by its newest partition, not its oldest', () => {
    expect(
      staleWatchers([
        { watcher: 'graph-mail', ageMinutes: 400 },
        { watcher: 'graph-mail', ageMinutes: 3 },
      ]),
    ).toEqual([]);
  });
});

describe('shellStatusLine', () => {
  it('says paused before anything else', () => {
    expect(shellStatusLine({ paused: true, mode: 'live', cursors: [] })).toEqual({
      tone: 'red',
      text: 'Paused',
    });
  });

  it('reports every watcher healthy in live mode', () => {
    expect(
      shellStatusLine({
        paused: false,
        mode: 'live',
        cursors: [{ watcher: 'notion', ageMinutes: 2 }],
      }),
    ).toEqual({ tone: 'green', text: 'Live, all watchers healthy' });
  });

  it('names a single stale watcher and counts several', () => {
    expect(
      shellStatusLine({
        paused: false,
        mode: 'dry_run',
        cursors: [{ watcher: 'jamie', ageMinutes: 300 }],
      }),
    ).toEqual({ tone: 'peach', text: 'Dry run, Jamie is stale' });
    expect(
      shellStatusLine({
        paused: false,
        mode: 'live',
        cursors: [
          { watcher: 'jamie', ageMinutes: 300 },
          { watcher: 'notion', ageMinutes: 90 },
        ],
      }),
    ).toEqual({ tone: 'peach', text: 'Live, 2 watchers stale' });
  });
});
