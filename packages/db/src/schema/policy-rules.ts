import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { decision, ruleCreator } from '../enums.js';
import { createdAt, ulid, ulidCheck, updatedAt } from './columns.js';
import { organisationOrPrincipalId } from './principals.js';

/**
 * Policy rules (spec section 6.2). `action_class`, `counterparty_class` and
 * `system` are text rather than enums because a rule may hold the wildcard
 * '*' in any of the three dimensions. `packages/policy` validates the value
 * against the enum list or '*' at write time.
 */
export const policyRules = pgTable(
  'policy_rules',
  {
    id: ulid('id').primaryKey(),
    /** Null is an organisation default; set is the principal's own rule (ADR 0019). */
    principalId: organisationOrPrincipalId(),
    version: integer('version').notNull(),
    active: boolean('active').notNull().default(true),
    actionClass: text('action_class').notNull(),
    counterpartyClass: text('counterparty_class').notNull(),
    system: text('system').notNull(),
    decision: decision('decision').notNull(),
    conditions: jsonb('conditions'),
    createdBy: ruleCreator('created_by').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    supersededBy: ulid('superseded_by'),
  },
  (table) => [
    index('policy_rules_cell_idx').on(table.actionClass, table.counterpartyClass, table.system),
    index('policy_rules_active_idx').on(table.active),
    ulidCheck('policy_rules', 'id'),
    ulidCheck('policy_rules', 'superseded_by'),
  ],
);

export type PolicyRule = typeof policyRules.$inferSelect;
export type NewPolicyRule = typeof policyRules.$inferInsert;
