import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { jobOrigin } from '../enums.js';
import { createdAt, ulid, ulidCheck, updatedAt } from './columns.js';
import { principalId } from './principals.js';

/**
 * One row per job per principal (ADR 0025, docs/plans/jobs.md section 4).
 * Code declares every system job with its default schedule; this row holds
 * the principal's own choices about it: whether it is enabled and any
 * schedule override within the declared bounds. The worker's reconciler
 * creates rows lazily with the declared defaults and turns them into
 * pg-boss schedules. `locked` mirrors the declaration so the api can refuse
 * to disable a job without importing the worker's registry.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: ulid('id').primaryKey(),
    principalId: principalId(),
    /** The job's stable name, which is also its pg-boss queue. */
    slug: text('slug').notNull(),
    origin: jobOrigin('origin').notNull().default('system'),
    enabled: boolean('enabled').notNull().default(true),
    /** A cron expression replacing the declared default; null keeps the default. */
    scheduleOverride: text('schedule_override'),
    locked: boolean('locked').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    ulidCheck('jobs', 'id'),
    uniqueIndex('jobs_principal_slug_idx').on(table.principalId, table.slug),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
