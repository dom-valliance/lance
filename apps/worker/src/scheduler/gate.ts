import type { SystemControl } from '@lance/ledger';

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
}
