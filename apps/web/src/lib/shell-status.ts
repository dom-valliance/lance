import type { Tone } from '@/lib/tones';

/**
 * The one-line health summary at the foot of the sidebar ("Live, all
 * watchers healthy", "Live, Jamie is stale", "Paused"). Built from the
 * api's status snapshot; pure so it is tested without a render.
 */

export interface WatcherAge {
  watcher: string;
  ageMinutes: number;
}

export interface ShellStatusInput {
  paused: boolean;
  mode: 'live' | 'dry_run';
  cursors: WatcherAge[];
}

export interface ShellStatusLine {
  tone: Tone;
  text: string;
}

/**
 * The watchers poll every 10 to 15 minutes (spec 7.1), so an hour without
 * a cursor write means something stopped.
 */
export const STALE_AFTER_MINUTES = 60;

const WATCHER_NAMES: Record<string, string> = {
  'graph-mail': 'Mail',
  'graph-calendar': 'Calendar',
  jamie: 'Jamie',
  notion: 'Notion',
  'agent-logs': 'Agent logs',
};

const watcherName = (watcher: string): string => WATCHER_NAMES[watcher] ?? watcher;

/** The watchers whose newest cursor is older than the threshold, by name. */
export function staleWatchers(cursors: WatcherAge[], threshold = STALE_AFTER_MINUTES): string[] {
  const newest = new Map<string, number>();
  for (const cursor of cursors) {
    const current = newest.get(cursor.watcher);
    if (current === undefined || cursor.ageMinutes < current) {
      newest.set(cursor.watcher, cursor.ageMinutes);
    }
  }
  return [...newest.entries()]
    .filter(([, age]) => age > threshold)
    .map(([watcher]) => watcherName(watcher))
    .sort((a, b) => a.localeCompare(b));
}

export function shellStatusLine(input: ShellStatusInput): ShellStatusLine {
  if (input.paused) return { tone: 'red', text: 'Paused' };
  const mode = input.mode === 'live' ? 'Live' : 'Dry run';
  const stale = staleWatchers(input.cursors);
  if (stale.length === 0) return { tone: 'green', text: `${mode}, all watchers healthy` };
  if (stale.length === 1) return { tone: 'peach', text: `${mode}, ${stale[0] ?? ''} is stale` };
  return { tone: 'peach', text: `${mode}, ${String(stale.length)} watchers stale` };
}
