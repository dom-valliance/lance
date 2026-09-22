import type { AgeingEmphasis } from '@/components/ageing';

/**
 * Due-date labels for anything that carries a calendar date without a
 * time (Notion tasks hold `YYYY-MM-DD`). Days are counted in Europe/London
 * so a task due today reads "due today" all day, whatever the hour.
 */

const LONDON = 'Europe/London';

/** The calendar day of `date` in London as `YYYY-MM-DD`. */
export function londonDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `fromDay` to `toDay`, both `YYYY-MM-DD`. */
const daysBetweenDays = (fromDay: string, toDay: string): number =>
  Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);

const pluralDays = (value: number): string => `${String(value)} day${value === 1 ? '' : 's'}`;

export interface DueLabel {
  label: string;
  emphasis: AgeingEmphasis;
}

/** "overdue by 2 days", "due today", "due in 4 days" or "no date" for a `YYYY-MM-DD` due date. */
export function dueLabel(due: string | null, now: Date = new Date()): DueLabel {
  if (due === null) return { label: 'no date', emphasis: 'none' };
  const days = daysBetweenDays(londonDay(now), due);
  if (Number.isNaN(days)) return { label: 'no date', emphasis: 'none' };
  if (days < 0) return { label: `overdue by ${pluralDays(-days)}`, emphasis: 'overdue' };
  if (days === 0) return { label: 'due today', emphasis: 'soon' };
  if (days === 1) return { label: 'due tomorrow', emphasis: 'none' };
  return { label: `due in ${pluralDays(days)}`, emphasis: 'none' };
}

/** Which emphasis a commitment's ageing label (see commitment-view.ts) deserves. */
export function ageingEmphasis(label: string): AgeingEmphasis {
  if (label.startsWith('overdue')) return 'overdue';
  if (label === 'due today') return 'soon';
  return 'none';
}
