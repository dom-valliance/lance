import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { decision } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck } from './columns.js';

/**
 * Every policy evaluation, with the matched rule, the inputs and the result
 * (spec section 5.1). Referenced by `ledger_events.policy_decision_id`.
 */
export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: ulid('id').primaryKey(),
    decision: decision('decision').notNull(),
    ruleId: ulid('rule_id'),
    reason: text('reason').notNull(),
    input: jsonb('input').notNull(),
    evaluatedAt: timestamptz('evaluated_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index('policy_decisions_evaluated_at_idx').on(table.evaluatedAt),
    ulidCheck('policy_decisions', 'id'),
    ulidCheck('policy_decisions', 'rule_id'),
  ],
);

export type PolicyDecision = typeof policyDecisions.$inferSelect;
export type NewPolicyDecision = typeof policyDecisions.$inferInsert;
