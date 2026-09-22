import { budgetGuardDetector } from './budgetGuard.js';
import { calendarConflictDetector } from './calendarConflict.js';
import { clientMailUnansweredDetector } from './clientMailUnanswered.js';
import { commitmentOverdueDetector } from './commitmentOverdue.js';
import { costSpikeDetector } from './costSpike.js';
import { proposalExpiringDetector } from './proposalExpiring.js';
import { unknownAttendeeDetector } from './unknownAttendee.js';
import type { Detector } from './types.js';

/**
 * The detectors spec 11 asks for that read what Lance already knows. The
 * rest of the table (`watcher_failed`, `breaker_open`,
 * `token_refresh_failed`, `agent_step_skipped`, `stale_watermark`,
 * `risk_language_in_client_mail`, `auto_rule_demoted`) is raised at the
 * point of failure by the runner, the connectors, the agent-logs watcher,
 * triage and the promotion analyser, so there is nothing to detect after
 * the fact.
 */

const DETECTORS: readonly Detector[] = [
  costSpikeDetector,
  budgetGuardDetector,
  commitmentOverdueDetector,
  calendarConflictDetector,
  unknownAttendeeDetector,
  clientMailUnansweredDetector,
  proposalExpiringDetector,
];

export type DetectorName = (typeof DETECTORS)[number]['name'];

export interface AllDetectorsOptions {
  /**
   * Cron overrides by detector name, in the configured time zone. For a
   * deployment that wants a cadence other than the one spec 11 implies.
   */
  schedules?: Readonly<Record<string, string>>;
  /** Detectors to leave out, for turning one off without a deploy of its own. */
  exclude?: readonly string[];
}

/** Every detector the worker registers, in the order the alerts page reads best. */
export function allDetectors(options: AllDetectorsOptions = {}): Detector[] {
  const exclude = new Set(options.exclude ?? []);
  const schedules = options.schedules ?? {};
  return DETECTORS.filter((detector) => !exclude.has(detector.name)).map((detector) => {
    const schedule = schedules[detector.name];
    return schedule === undefined ? detector : { ...detector, schedule };
  });
}

export { budgetGuardDetector } from './budgetGuard.js';
export { calendarConflictDetector } from './calendarConflict.js';
export { clientMailUnansweredDetector } from './clientMailUnanswered.js';
export { commitmentOverdueDetector } from './commitmentOverdue.js';
export { costSpikeDetector } from './costSpike.js';
export { proposalExpiringDetector } from './proposalExpiring.js';
export { unknownAttendeeDetector } from './unknownAttendee.js';
export type { DetectedAlert, Detector, DetectorContext } from './types.js';
