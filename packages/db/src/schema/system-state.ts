import { sql } from 'drizzle-orm';
import { boolean, check, integer, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { systemMode } from '../enums.js';
import { timestamptz, updatedAt } from './columns.js';

/**
 * The global row above every principal's `principal_state` (ADR 0015):
 * the organisation-wide kill switch, the mode ceiling and the organisation
 * cost ceiling (spec section 5.1, CLAUDE.md non-negotiable 7). The CHECK on
 * `id` makes a second row impossible, so every reader can select by id 1
 * without ordering. Mode defaults to `dry_run`: writes are opt in. The
 * quiet hours and push budget columns predate ADR 0015 and are not read;
 * each principal's own live in `principal_state`.
 */
export const systemState = pgTable(
  'system_state',
  {
    id: integer('id').primaryKey(),
    paused: boolean('paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    pausedBy: text('paused_by'),
    pausedAt: timestamptz('paused_at'),
    mode: systemMode('mode').notNull().default('dry_run'),
    quietHoursStart: text('quiet_hours_start').notNull().default('19:00'),
    quietHoursEnd: text('quiet_hours_end').notNull().default('07:00'),
    pushBudgetPerHour: integer('push_budget_per_hour').notNull().default(3),
    /** Spec 13: daily model spend ceiling in GBP, changed from Settings. */
    costCeilingGbp: numeric('cost_ceiling_gbp', { precision: 10, scale: 2, mode: 'number' })
      .notNull()
      .default(15),
    updatedAt: updatedAt(),
  },
  () => [check('system_state_single_row', sql.raw('"id" = 1'))],
);

export const SYSTEM_STATE_ID = 1;

export type SystemState = typeof systemState.$inferSelect;
export type NewSystemState = typeof systemState.$inferInsert;
