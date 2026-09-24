import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import {
  actionClass,
  counterpartyClass,
  decision,
  proposalStatus,
  reversibility,
  targetSystem,
} from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck, updatedAt } from './columns.js';
import { principalId } from './principals.js';

/**
 * One proposed write, its policy verdict and its decision trail
 * (spec section 5.1). `compensation_payload` holds the undo instruction the
 * executor stores for compensatable actions (spec section 7.5 step 5).
 */
export const proposals = pgTable(
  'proposals',
  {
    id: ulid('id').primaryKey(),
    principalId: principalId(),
    correlationId: ulid('correlation_id').notNull(),
    actionClass: actionClass('action_class').notNull(),
    counterpartyClass: counterpartyClass('counterparty_class').notNull(),
    targetSystem: targetSystem('target_system').notNull(),
    targetRecordId: text('target_record_id'),
    reversibility: reversibility('reversibility').notNull(),
    payload: jsonb('payload').notNull(),
    editedPayload: jsonb('edited_payload'),
    preview: text('preview').notNull(),
    rationale: text('rationale').notNull(),
    provenance: jsonb('provenance').notNull(),
    policyDecision: decision('policy_decision').notNull(),
    policyRuleId: ulid('policy_rule_id'),
    status: proposalStatus('status').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamptz('decided_at'),
    decisionNote: text('decision_note'),
    slackChannel: text('slack_channel'),
    slackTs: text('slack_ts'),
    expiresAt: timestamptz('expires_at').notNull(),
    executionEventId: ulid('execution_event_id'),
    compensationPayload: jsonb('compensation_payload'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('proposals_status_idx').on(table.status),
    index('proposals_correlation_id_idx').on(table.correlationId),
    index('proposals_expires_at_idx').on(table.expiresAt),
    ulidCheck('proposals', 'id'),
    ulidCheck('proposals', 'correlation_id'),
    ulidCheck('proposals', 'policy_rule_id'),
    ulidCheck('proposals', 'execution_event_id'),
  ],
);

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
