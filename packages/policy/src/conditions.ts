import type { PolicyInput, PolicyRule } from '@lance/shared';

export interface WorkingHours {
  timeZone: string;
  /** HH:MM, inclusive */
  start: string;
  /** HH:MM, exclusive */
  end: string;
  /** 1 is Monday, 7 is Sunday */
  days: readonly number[];
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timeZone: 'Europe/London',
  start: '07:00',
  end: '19:00',
  days: [1, 2, 3, 4, 5],
};

export type UnmetCondition =
  | 'withinWorkingHours'
  | 'maxPerDay'
  | 'maxPerHour'
  | 'requireCriticPass'
  | 'minConfidence'
  | 'labelsAnyOf'
  | 'targetAnyOf';

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Local weekday (1 Monday to 7 Sunday) and minutes since midnight in the given zone. */
function localClock(iso: string, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const field: Record<string, string> = {};
  for (const part of parts) field[part.type] = part.value;
  const utcMidnight = Date.UTC(
    Number(field['year']),
    Number(field['month']) - 1,
    Number(field['day']),
  );
  const weekday = ((new Date(utcMidnight).getUTCDay() + 6) % 7) + 1;
  return { weekday, minutes: Number(field['hour']) * 60 + Number(field['minute']) };
}

export function isWithinWorkingHours(iso: string, hours: WorkingHours): boolean {
  const { weekday, minutes } = localClock(iso, hours.timeZone);
  if (!hours.days.includes(weekday)) return false;
  return minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end);
}

/**
 * Returns every condition on the rule that the input fails to satisfy.
 * requireCriticPass defaults to true for auto rules (spec 6.2). At the
 * proposal stage the critic has not run yet, so only an explicit failure
 * counts; at the execution stage an explicit pass is required.
 */
export function unmetConditions(
  rule: PolicyRule,
  input: PolicyInput,
  hours: WorkingHours = DEFAULT_WORKING_HOURS,
): UnmetCondition[] {
  const conditions = rule.conditions ?? {};
  const unmet: UnmetCondition[] = [];

  if (conditions.withinWorkingHours === true && !isWithinWorkingHours(input.at, hours)) {
    unmet.push('withinWorkingHours');
  }
  if (conditions.maxPerDay !== undefined && (input.countsToday ?? 0) >= conditions.maxPerDay) {
    unmet.push('maxPerDay');
  }
  if (conditions.maxPerHour !== undefined && (input.countsThisHour ?? 0) >= conditions.maxPerHour) {
    unmet.push('maxPerHour');
  }

  const requireCriticPass = conditions.requireCriticPass ?? true;
  if (requireCriticPass) {
    if (input.criticPassed === false) unmet.push('requireCriticPass');
    else if (input.stage === 'execution' && input.criticPassed !== true)
      unmet.push('requireCriticPass');
  }

  if (conditions.minConfidence !== undefined) {
    if (input.confidence === undefined || input.confidence < conditions.minConfidence) {
      unmet.push('minConfidence');
    }
  }
  const allowedLabels = conditions.labelsAnyOf;
  if (allowedLabels !== undefined) {
    const labels = input.labels ?? [];
    if (!labels.some((label) => allowedLabels.includes(label))) unmet.push('labelsAnyOf');
  }
  if (conditions.targetAnyOf !== undefined) {
    if (input.target === undefined || !conditions.targetAnyOf.includes(input.target)) {
      unmet.push('targetAnyOf');
    }
  }
  return unmet;
}
