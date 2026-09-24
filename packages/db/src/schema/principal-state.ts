import { boolean, integer, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { systemMode } from '../enums.js';
import { timestamptz, updatedAt } from './columns.js';
import { principalId } from './principals.js';

/**
 * One principal's run state (ADR 0015): their own pause, mode, quiet
 * hours, push budget and daily cost ceiling. `system_state` is the global
 * row above it; every reader applies whichever of the two is stricter.
 */
export const principalState = pgTable('principal_state', {
  principalId: principalId().primaryKey(),
  paused: boolean('paused').notNull().default(false),
  pausedReason: text('paused_reason'),
  pausedBy: text('paused_by'),
  pausedAt: timestamptz('paused_at'),
  mode: systemMode('mode').notNull().default('dry_run'),
  quietHoursStart: text('quiet_hours_start').notNull().default('19:00'),
  quietHoursEnd: text('quiet_hours_end').notNull().default('07:00'),
  pushBudgetPerHour: integer('push_budget_per_hour').notNull().default(3),
  /** Spec 13: this principal's daily model spend ceiling in GBP. */
  costCeilingGbp: numeric('cost_ceiling_gbp', { precision: 10, scale: 2, mode: 'number' })
    .notNull()
    .default(15),
  updatedAt: updatedAt(),
});

export type PrincipalState = typeof principalState.$inferSelect;
export type NewPrincipalState = typeof principalState.$inferInsert;
