import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enum value lists for the relational schema (spec section 5.1).
 *
 * ADR 0010: the canonical lists live in `@lance/shared` as Zod enums. They are
 * repeated here as local `const` tuples so that `@lance/db` has no dependency
 * on `@lance/shared`, and a test asserts the two sets are equal. Keep the
 * values and their order verbatim.
 */

export const LEDGER_KIND_VALUES = [
  'observed',
  'resolved',
  'proposed',
  'decided',
  'executed',
  'failed',
  'alert_raised',
  'alert_acked',
  'rule_changed',
  'state_changed',
  'retention_applied',
  'cost_recorded',
] as const;

export const ACTION_CLASS_VALUES = [
  'read',
  'classify',
  'draft_email',
  'apply_category',
  'move_mail',
  'create_task',
  'update_task',
  'complete_task',
  'create_tag',
  'apply_tag',
  'create_calendar_hold',
  'post_slack',
  'send_email',
  'delete',
  'rule_change',
] as const;

export const COUNTERPARTY_CLASS_VALUES = [
  'self',
  'internal',
  'client',
  'prospect',
  'partner',
  'vendor',
  'unknown',
] as const;

export const TARGET_SYSTEM_VALUES = ['graph', 'jamie', 'notion', 'slack', 'lance'] as const;

export const REVERSIBILITY_VALUES = ['reversible', 'compensatable', 'irreversible'] as const;

export const DECISION_VALUES = ['forbid', 'propose', 'auto'] as const;

export const PROPOSAL_STATUS_VALUES = [
  'pending',
  'approved',
  'edited',
  'rejected',
  'expired',
  'held',
  'executing',
  'executed',
  'failed',
] as const;

export const ALERT_SEVERITY_VALUES = ['P0', 'P1', 'P2'] as const;

export const ALERT_STATUS_VALUES = ['open', 'acked', 'resolved', 'suppressed'] as const;

export const COMMITMENT_DIRECTION_VALUES = ['outbound', 'inbound'] as const;

export const COMMITMENT_STATUS_VALUES = ['open', 'chased', 'done', 'dropped'] as const;

export const SYSTEM_MODE_VALUES = ['live', 'dry_run'] as const;

export const RULE_CREATOR_VALUES = ['user:dom', 'agent:promotion-analyser'] as const;

export const BRIEF_KIND_VALUES = [
  'morning_brief',
  'afternoon_board',
  'meeting_prep',
  'debrief',
  'weekly_review',
] as const;

export const AGENT_RUN_STATUS_VALUES = ['running', 'succeeded', 'failed'] as const;

export const ledgerKind = pgEnum('ledger_kind', LEDGER_KIND_VALUES);
export const actionClass = pgEnum('action_class', ACTION_CLASS_VALUES);
export const counterpartyClass = pgEnum('counterparty_class', COUNTERPARTY_CLASS_VALUES);
export const targetSystem = pgEnum('target_system', TARGET_SYSTEM_VALUES);
export const reversibility = pgEnum('reversibility', REVERSIBILITY_VALUES);
export const decision = pgEnum('decision', DECISION_VALUES);
export const proposalStatus = pgEnum('proposal_status', PROPOSAL_STATUS_VALUES);
export const alertSeverity = pgEnum('alert_severity', ALERT_SEVERITY_VALUES);
export const alertStatus = pgEnum('alert_status', ALERT_STATUS_VALUES);
export const commitmentDirection = pgEnum('commitment_direction', COMMITMENT_DIRECTION_VALUES);
export const commitmentStatus = pgEnum('commitment_status', COMMITMENT_STATUS_VALUES);
export const systemMode = pgEnum('system_mode', SYSTEM_MODE_VALUES);
export const ruleCreator = pgEnum('rule_creator', RULE_CREATOR_VALUES);
export const briefKind = pgEnum('brief_kind', BRIEF_KIND_VALUES);
export const agentRunStatus = pgEnum('agent_run_status', AGENT_RUN_STATUS_VALUES);
