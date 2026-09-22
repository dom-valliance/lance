import type { PgBoss } from 'pg-boss';
import { raiseAlert, type RaiseAlertResult } from '../raise.js';
import type { Detector, DetectorContext } from '../detectors/types.js';

/**
 * Runs one detector and records what it found. Each detector has its own
 * queue and cron so a slow one never delays another, and the actor names
 * the detector so the ledger says which code raised what.
 */
export async function runDetector(
  detector: Detector,
  context: DetectorContext,
): Promise<RaiseAlertResult[]> {
  const found = await detector.run(context);
  const results: RaiseAlertResult[] = [];
  for (const alert of found) {
    results.push(
      await raiseAlert(context.db, { ...alert, actor: `system:detector-${detector.name}` }),
    );
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
  await boss.work(queue, async () => {
    await runDetector(detector, context);
  });
}
