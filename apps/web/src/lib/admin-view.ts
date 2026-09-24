import type { Tone } from '@/lib/tones';

/**
 * View model for the admin page (ADR 0024: health, never content). Every
 * value here is a status, a count, an age or a name; the api returns
 * nothing else, and this module has nothing to render content with.
 */

export type PrincipalStatus = 'onboarding' | 'active' | 'paused' | 'offboarded';

export const PRINCIPAL_STATUS_LABELS: Record<PrincipalStatus, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  paused: 'Paused',
  offboarded: 'Offboarded',
};

export const PRINCIPAL_STATUS_TONES: Record<PrincipalStatus, Tone> = {
  onboarding: 'peach',
  active: 'green',
  paused: 'pink',
  offboarded: 'outline',
};

/** The onboarding steps in checklist order, as the api names them. */
export const ONBOARDING_STEP_LABELS: Record<string, string> = {
  notice: 'Notice accepted',
  microsoft365: 'Microsoft 365',
  jamie: 'Jamie',
  slack: 'Slack linked',
  hours: 'Hours confirmed',
};

export interface OnboardingStep {
  step: string;
  done: boolean;
}

/** "3 of 5 steps done", or "Complete". */
export function onboardingSummary(steps: readonly OnboardingStep[]): string {
  const done = steps.filter((entry) => entry.done).length;
  if (steps.length > 0 && done === steps.length) return 'Complete';
  return `${String(done)} of ${String(steps.length)} steps done`;
}

export function onboardingStepLabel(step: string): string {
  return ONBOARDING_STEP_LABELS[step] ?? step;
}

export type SecretStateValue = 'stored' | 'deleted' | 'never_stored';

export const SECRET_STATE_LABELS: Record<SecretStateValue, string> = {
  stored: 'Stored',
  deleted: 'Deleted',
  never_stored: 'Not connected',
};

export const SECRET_STATE_TONES: Record<SecretStateValue, Tone> = {
  stored: 'green',
  deleted: 'outline',
  never_stored: 'neutral',
};

export const CONNECTOR_LABELS: Record<string, string> = {
  graph: 'Microsoft 365',
  jamie: 'Jamie',
  notion: 'Notion',
  slack: 'Slack',
};

export function connectorLabel(connector: string): string {
  return CONNECTOR_LABELS[connector] ?? connector;
}

/** A watcher whose last run is older than this reads as stale on the page. */
export const STALE_WATCHER_MINUTES = 6 * 60;

export function isStaleWatcher(ageMinutes: number): boolean {
  return ageMinutes > STALE_WATCHER_MINUTES;
}

/**
 * The confirmation the offboard form asks for: the principal's UPN typed
 * in full, so a slip of the mouse cannot delete someone's credentials.
 */
export function offboardConfirmed(typed: string, upn: string): boolean {
  return typed.trim().toLowerCase() === upn.toLowerCase();
}

/** `YYYY-MM-DD` from a date input as the start of that day in UTC. */
export function dayStartIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The day after `YYYY-MM-DD`, so a period "to 24 September" includes that day. */
export function dayEndIso(day: string): string | null {
  const start = dayStartIso(day);
  if (start === null) return null;
  return new Date(Date.parse(start) + 24 * 3600 * 1000).toISOString();
}

/** `lance-evidence-system-2026-09-01-to-2026-09-24.json`, or with the principal's id. */
export function evidenceFilename(from: string, to: string, principalId: string | null): string {
  const scope = principalId === null ? 'system' : principalId;
  return `lance-evidence-${scope}-${from}-to-${to}.json`;
}
