import type { JamieReads } from '@lance/connectors';
import { nowIso } from '@lance/shared';
import type { Observation, PollResult, Watcher } from '../types.js';
import { MEETINGS_PARTITION, normaliseMeeting, pollMeetings } from './meetings.js';
import { TASKS_PARTITION, normaliseTask, pollTasks } from './tasks.js';

/**
 * The `jamie` watcher (spec 7.1): meetings, transcripts once they are
 * ready, the action items assigned to Dom and to others, and the tags on a
 * meeting, every fifteen minutes.
 *
 * Reads only (ADR 0005). It never calls a model: every label it attaches is
 * decided from the record. Transcript text is never logged and never
 * appears in an error message; the ledger is the one place it lands.
 */

export const JAMIE_WATCHER_NAME = 'jamie';

/** Spec 7.1: every 15 minutes, at every hour of every day. */
export const JAMIE_SCHEDULES = ['*/15 * * * *'] as const;

/** Meetings and their action items page separately, so each keeps its own cursor. */
export const JAMIE_PARTITIONS = [MEETINGS_PARTITION, TASKS_PARTITION] as const;

export interface JamieWatcherOptions {
  reads: Pick<JamieReads, 'listMeetings' | 'getMeeting' | 'listTasks'>;
  /** Dom's mailbox, compared case-insensitively to decide attendance and assignment. */
  domEmail: string;
  now?: () => string;
  schedules?: readonly string[];
}

function unknownPartition(partition: string): Error {
  return new Error(
    `jamie watcher has no partition named "${partition}". Expected ${JAMIE_PARTITIONS.join(' or ')}.`,
  );
}

export function createJamieWatcher(options: JamieWatcherOptions): Watcher {
  const now = options.now ?? nowIso;

  return {
    name: JAMIE_WATCHER_NAME,
    sourceSystem: 'jamie',
    schedules: [...(options.schedules ?? JAMIE_SCHEDULES)],

    partitions: () => Promise.resolve([...JAMIE_PARTITIONS]),

    poll(partition: string, cursor: string | null): Promise<PollResult> {
      if (partition === MEETINGS_PARTITION) return pollMeetings(options.reads, cursor, now());
      if (partition === TASKS_PARTITION) return pollTasks(options.reads, cursor, now());
      return Promise.reject(unknownPartition(partition));
    },

    normalise(record, partition: string): Promise<Observation> {
      if (partition === MEETINGS_PARTITION) {
        return Promise.resolve(normaliseMeeting(record, options.domEmail));
      }
      if (partition === TASKS_PARTITION) {
        return Promise.resolve(normaliseTask(record, options.domEmail));
      }
      return Promise.reject(unknownPartition(partition));
    },
  };
}
