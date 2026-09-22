import type { PgBoss } from 'pg-boss';
import { work } from '../../scheduler/boss.js';
import { raiseAlert, type RaiseAlertResult } from '../raise.js';
import type { Detector, DetectorContext } from '../detectors/types.js';

/**
 * Runs one detector and records what it found. Each detector has its own
 * queue and cron so a slow one never delays another, and the actor names
 * the detector so the ledger says which code raised what.
 */
/** Ledger actors allow letters and hyphens only, so a detector's snake_case name is hyphenated. */
export function detectorActor(detector: Pick<Detector, 'name'>): string {
  return `system:detector-${detector.name.replace(/_/g, '-')}`;
}

export async function runDetector(
  detector: Detector,
  context: DetectorContext,
): Promise<RaiseAlertResult[]> {
  const found = await detector.run(context);
  const results: RaiseAlertResult[] = [];
  for (const alert of found) {
    results.push(await raiseAlert(context.db, { ...alert, actor: detectorActor(detector) }));
  }
  return results;
}

export function detectorQueue(detector: Pick<Detector, 'name'>): string {
  return `detector-${detector.name}`;
}

export async function registerDetector(
  boss: PgBoss,
  detector: Detector,
  context: DetectorContext,
): Promise<void> {
  const queue = detectorQueue(detector);
  await boss.createQueue(queue);
  await boss.schedule(queue, detector.schedule, {}, { tz: context.config.timeZone, key: queue });
  await work(boss, queue, async () => {
    await runDetector(detector, context);
  });
}
