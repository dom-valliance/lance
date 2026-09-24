import { CronExpressionParser } from 'cron-parser';

/**
 * Cron arithmetic for the job registry (ADR 0025): the next runs of a
 * schedule, for `/lance jobs`, and the checks that keep a schedule override
 * inside its job's declared bounds. `cron-parser` is the parser pg-boss
 * already uses to fire the same expressions, so the two cannot disagree
 * about when a schedule runs and no second cron dialect enters the tree.
 */

export interface OccurrenceOptions {
  /** IANA zone the expression is read in, as pg-boss reads it. */
  readonly timeZone: string;
  /** Occurrences strictly after this instant. */
  readonly from: Date;
  readonly count: number;
}

/** Throws a message naming the expression when it is not a five-field cron. */
export function assertCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `"${expression}" is not a five-field cron expression (minute hour day-of-month month day-of-week).`,
    );
  }
  try {
    CronExpressionParser.parse(expression, { tz: 'UTC' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`"${expression}" is not a valid cron expression: ${reason}`);
  }
}

/** The next `count` instants `expression` fires at after `from`. */
export function nextOccurrences(expression: string, options: OccurrenceOptions): Date[] {
  assertCron(expression);
  const parsed = CronExpressionParser.parse(expression, {
    tz: options.timeZone,
    currentDate: options.from,
  });
  return parsed.take(options.count).map((date) => date.toDate());
}

/** The earliest next run across several expressions, or null for none. */
export function nextRun(expressions: readonly string[], timeZone: string, from: Date): Date | null {
  let earliest: Date | null = null;
  for (const expression of expressions) {
    const [next] = nextOccurrences(expression, { timeZone, from, count: 1 });
    if (next !== undefined && (earliest === null || next < earliest)) earliest = next;
  }
  return earliest;
}
