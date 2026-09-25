import type { RunState, SystemControl } from '@lance/ledger';

export type GateVerdict = { runnable: true } | { runnable: false; reason: string };

/**
 * The kill switch check every job runs first (spec 4.3). It reads
 * system_state fresh each time, so a pause takes effect on the next job start
 * rather than on the next scheduler tick. Reads may continue while paused;
 * only writes and watcher polls stop.
 */
export class PauseGate {
  constructor(private readonly control: Pick<SystemControl, 'read'>) {}

  async check(): Promise<GateVerdict> {
    const state = await this.control.read();
    if (state.paused) {
      return { runnable: false, reason: state.pausedReason ?? 'paused' };
    }
    return { runnable: true };
  }

  /**
   * The check before an external write (spec 6.3, non-negotiable 7): a
   * pause stops it, and so does any mode other than live. Watchers and
   * triage keep running in dry run so the ledger fills; only the executor
   * asks this question.
   */
  async checkWrite(): Promise<GateVerdict> {
    return writeVerdict(await this.control.read());
  }
}

/** The write check as a function of the run state, for use under a lock. */
export function writeVerdict(state: RunState): GateVerdict {
  if (state.paused) {
    return { runnable: false, reason: state.pausedReason ?? 'paused' };
  }
  if (state.mode !== 'live') {
    return {
      runnable: false,
      reason: `${state.mode} mode: external writes are held until the mode is live`,
    };
  }
  return { runnable: true };
}
