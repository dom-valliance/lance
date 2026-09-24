import { scopedDb, type Db } from '@lance/db';
import {
  applyRetention,
  type RetentionResult,
  type RetentionTrigger,
  type RetentionWindows,
} from '@lance/ledger';
import type { Config } from '@lance/shared';
import { GRAPH_MAIL_WATCHER_NAME } from '../watchers/graph/index.js';

/**
 * The retention job (spec 4.4, docs/compliance/retention.md): nightly, per
 * principal, whatever their status, because a paused or offboarded
 * principal's data ages out on the same schedule as anyone's. The windows
 * come from config (`RETENTION_*_DAYS`); offboarding runs it with the three
 * content windows at zero.
 */


export const nightlyWindows = (config: Pick<Config, 'retention'>): RetentionWindows => ({
  mailBodiesDays: config.retention.mailBodiesDays,
  transcriptsDays: config.retention.transcriptsDays,
  modelLogsDays: config.retention.modelLogsDays,
  ledgerDays: config.retention.ledgerDays,
});

/**
 * Offboarding's run: mail bodies, transcripts, what triage copied from
 * them, and model logs go now; the ledger window is unchanged, so the
 * principal's audit trail stays, payloads nulled as it ages (ADR 0011).
 */
export const offboardingWindows = (config: Pick<Config, 'retention'>): RetentionWindows => ({
  ...nightlyWindows(config),
  mailBodiesDays: 0,
  transcriptsDays: 0,
  modelLogsDays: 0,
});

export interface RetentionRun {
  root: Db;
  config: Pick<Config, 'retention'>;
  principalId: string;
  trigger: RetentionTrigger;
  actor?: string;
  now?: () => string;
}

export async function runRetention(run: RetentionRun): Promise<RetentionResult> {
  return applyRetention(scopedDb(run.root, { principalId: run.principalId }), {
    windows: run.trigger === 'offboarding' ? offboardingWindows(run.config) : nightlyWindows(run.config),
    trigger: run.trigger,
    mailWatcher: GRAPH_MAIL_WATCHER_NAME,
    ...(run.actor === undefined ? {} : { actor: run.actor }),
    ...(run.now === undefined ? {} : { now: run.now }),
  });
}
