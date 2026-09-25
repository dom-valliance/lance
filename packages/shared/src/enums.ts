import { z } from 'zod';

/**
 * Enum value tuples for every domain enum in the spec. Each tuple is the
 * single source of truth: the Zod enum and the inferred type are derived
 * from it, and `@lance/db` builds its Drizzle `pgEnum`s from the same
 * arrays (ADR 0010), so a value added here is added everywhere.
 */

export const LEDGER_KINDS = [
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
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

export const SOURCE_SYSTEMS = ['graph', 'jamie', 'notion', 'slack', 'lance', 'webhook'] as const;
export const SourceSystemSchema = z.enum(SOURCE_SYSTEMS);
export type SourceSystem = z.infer<typeof SourceSystemSchema>;

export const ACTION_CLASSES = [
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
  'promote_to_shared',
] as const;
export const ActionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const COUNTERPARTY_CLASSES = [
  'self',
  'internal',
  'client',
  'prospect',
  'partner',
  'vendor',
  'unknown',
] as const;
export const CounterpartyClassSchema = z.enum(COUNTERPARTY_CLASSES);
export type CounterpartyClass = z.infer<typeof CounterpartyClassSchema>;

export const SYSTEMS = ['graph', 'jamie', 'notion', 'slack', 'lance'] as const;
export const SystemSchema = z.enum(SYSTEMS);
export type System = z.infer<typeof SystemSchema>;

export const REVERSIBILITIES = ['reversible', 'compensatable', 'irreversible'] as const;
export const ReversibilitySchema = z.enum(REVERSIBILITIES);
export type Reversibility = z.infer<typeof ReversibilitySchema>;

export const DECISIONS = ['forbid', 'propose', 'auto'] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const PROPOSAL_STATUSES = [
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
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ALERT_SEVERITIES = ['P0', 'P1', 'P2'] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const ALERT_STATUSES = ['open', 'acked', 'resolved', 'suppressed'] as const;
export const AlertStatusSchema = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const ALERT_KINDS = [
  'watcher_failed',
  'breaker_open',
  'token_refresh_failed',
  'agent_step_skipped',
  'stale_watermark',
  'cost_spike',
  'calendar_conflict',
  'external_meeting_unknown_attendee',
  'commitment_overdue_outbound',
  'client_mail_unanswered',
  'risk_language_in_client_mail',
  'auto_rule_demoted',
  'proposal_expiring',
  'principal_access_revoked',
  // A Slack user pressed a button on a proposal that is not their
  // principal's (ADR 0023). Raised in the proposal owner's scope.
  'foreign_decision_attempt',
  // Jobs queued without a principal (by a Phase 4 image) that the worker
  // could not give to one principal at boot, so it left them unrun.
  'unscoped_jobs_held',
] as const;
export const AlertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const COMMITMENT_DIRECTIONS = ['outbound', 'inbound'] as const;
export const CommitmentDirectionSchema = z.enum(COMMITMENT_DIRECTIONS);
export type CommitmentDirection = z.infer<typeof CommitmentDirectionSchema>;

export const COMMITMENT_STATUSES = ['open', 'chased', 'done', 'dropped'] as const;
export const CommitmentStatusSchema = z.enum(COMMITMENT_STATUSES);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const SYSTEM_MODES = ['live', 'dry_run'] as const;
export const SystemModeSchema = z.enum(SYSTEM_MODES);
export type SystemMode = z.infer<typeof SystemModeSchema>;

export const RULE_CREATORS = ['user:dom', 'agent:promotion-analyser'] as const;
export const RuleCreatorSchema = z.enum(RULE_CREATORS);
export type RuleCreator = z.infer<typeof RuleCreatorSchema>;

export const BRIEF_KINDS = [
  'morning_brief',
  'afternoon_board',
  'meeting_prep',
  'debrief',
  'weekly_review',
] as const;
export const BriefKindSchema = z.enum(BRIEF_KINDS);
export type BriefKind = z.infer<typeof BriefKindSchema>;

export const AGENT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const MAIL_LABELS = [
  'Deals',
  'Internal',
  'Action',
  'Calendar',
  'Alerts',
  'Newsletters',
  'Priority',
  'Notifications',
] as const;
export const MailLabelSchema = z.enum(MAIL_LABELS);
export type MailLabel = z.infer<typeof MailLabelSchema>;

/**
 * Reversibility per action class (spec 6.1: "Assigned per action class in
 * code"). `rule_change` is not itself an action a connector performs, but it
 * carries a policy decision like any other action class, so it needs a
 * reversibility for the policy engine; it is treated as irreversible
 * because a promoted rule changes live autonomy immediately.
 */
export const REVERSIBILITY_BY_ACTION_CLASS: Record<ActionClass, Reversibility> = {
  read: 'reversible',
  classify: 'reversible',
  apply_category: 'reversible',
  apply_tag: 'reversible',
  create_tag: 'reversible',
  post_slack: 'reversible',
  draft_email: 'compensatable',
  move_mail: 'compensatable',
  create_task: 'compensatable',
  update_task: 'compensatable',
  complete_task: 'compensatable',
  create_calendar_hold: 'compensatable',
  send_email: 'irreversible',
  delete: 'irreversible',
  rule_change: 'irreversible',
  // Irreversible like rule_change: once shared, every principal has seen it
  // (ADR 0017).
  promote_to_shared: 'irreversible',
};

/**
 * Hard-floor action classes: no rule, seed or promoted, can grant these
 * `auto`; the policy engine rejects such a rule at write time. `delete` and
 * `send_email` are hard floors at `forbid` (spec 6.2 evaluation order, step
 * 1: "Not consultable, not overridable"). `rule_change` is a narrower hard
 * floor that can never be `auto` but is otherwise a normal `propose` action
 * (spec 6.4: "rule_change itself can never be auto. Hard floor.").
 * `promote_to_shared` is the same kind of floor: private evidence becomes
 * shared context only through a decided proposal (ADR 0017, ADR 0019).
 */
export const HARD_FLOOR_ACTION_CLASSES = [
  'delete',
  'send_email',
  'rule_change',
  'promote_to_shared',
] as const;
