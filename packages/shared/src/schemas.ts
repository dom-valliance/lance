import { z } from 'zod';
import {
  ActionClassSchema,
  AlertKindSchema,
  AlertSeveritySchema,
  AlertStatusSchema,
  CommitmentDirectionSchema,
  CommitmentStatusSchema,
  CounterpartyClassSchema,
  DecisionSchema,
  LedgerKindSchema,
  ProposalStatusSchema,
  ReversibilitySchema,
  RuleCreatorSchema,
  AgentRunStatusSchema,
  SourceSystemSchema,
  SystemModeSchema,
  SystemSchema,
} from './enums.js';

/**
 * Zod schemas and inferred types for every record that crosses a package or
 * network boundary (spec 5.1). Field names are camelCase; the Drizzle layer
 * in `@lance/db` maps these to the snake_case column names in the spec.
 */

/** 26-character Crockford base32 ULID (spec 5.1: "Ids are ULIDs"). */
export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a 26-character Crockford base32 ULID');

/** ISO-8601 timestamp with an explicit offset. All timestamps are `timestamptz` (spec 5.1). */
const TimestampSchema = z.string().datetime({ offset: true });

/** `HH:MM`, 24-hour, used for quiet-hours boundaries. */
const HhMmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM" in 24-hour time');

/**
 * Actor identity on a ledger event (spec 5.1 examples: `agent:triage@1.4.0`,
 * `user:dom`, `system:retention`).
 */
const ActorSchema = z
  .string()
  .regex(
    /^(agent:[a-z-]+@\d+\.\d+\.\d+|user:[a-z]+|system:[a-z-]+)$/,
    'must be "agent:name@x.y.z", "user:name" or "system:name"',
  );

/** A JSON object payload with unknown shape, validated further downstream. */
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const ProvenanceRefSchema = z.object({
  system: SourceSystemSchema,
  recordId: z.string().min(1),
  hash: z.string().min(1),
  observedAt: TimestampSchema,
  url: z.string().url().optional(),
});
export type ProvenanceRef = z.infer<typeof ProvenanceRefSchema>;

export const LedgerEventSchema = z.object({
  id: UlidSchema,
  ts: TimestampSchema,
  actor: ActorSchema,
  kind: LedgerKindSchema,
  sourceSystem: SourceSystemSchema.nullable(),
  sourceRecordId: z.string().nullable(),
  sourceRecordHash: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  correlationId: UlidSchema,
  parentEventId: UlidSchema.nullable(),
  policyDecisionId: UlidSchema.nullable(),
  payload: JsonRecordSchema.nullable(),
  payloadHash: z.string(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/**
 * Input to append a ledger event: everything except the server-assigned `id`
 * and `payloadHash` (computed by the ledger writer from `payload` via
 * `hashRecord`). The caller supplies `ts`, the event time, which is not
 * necessarily "now".
 */
export const LedgerEventInputSchema = LedgerEventSchema.omit({
  id: true,
  payloadHash: true,
}).extend({
  sourceSystem: SourceSystemSchema.nullable().default(null),
  sourceRecordId: z.string().nullable().default(null),
  sourceRecordHash: z.string().nullable().default(null),
  idempotencyKey: z.string().nullable().default(null),
  parentEventId: UlidSchema.nullable().default(null),
  policyDecisionId: UlidSchema.nullable().default(null),
  payload: JsonRecordSchema.nullable().default(null),
});
export type LedgerEventInput = z.infer<typeof LedgerEventInputSchema>;
/** What a caller passes to the ledger writer: nullable fields may be omitted. */
export type LedgerEventInputCandidate = z.input<typeof LedgerEventInputSchema>;

/** The `PolicyRule` interface, spec 6.2, verbatim. */
export const PolicyRuleSchema = z.object({
  id: UlidSchema,
  version: z.int().positive(),
  active: z.boolean(),
  actionClass: z.union([ActionClassSchema, z.literal('*')]),
  counterpartyClass: z.union([CounterpartyClassSchema, z.literal('*')]),
  system: z.union([SystemSchema, z.literal('*')]),
  decision: DecisionSchema,
  conditions: z
    .object({
      withinWorkingHours: z.boolean().optional(),
      maxPerDay: z.int().positive().optional(),
      maxPerHour: z.int().positive().optional(),
      requireCriticPass: z.boolean().optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      // Restricts an `auto` rule to specific classifier labels, e.g. `move_mail`
      // auto only for the `Newsletters` and `Notifications` labels (spec 6.2 seed rules).
      labelsAnyOf: z.array(z.string().min(1)).min(1).optional(),
      // Restricts an `auto` rule to specific write targets, e.g. `move_mail` auto
      // only into the `AI-Filed` folder (spec 6.2 seed rules).
      targetAnyOf: z.array(z.string().min(1)).min(1).optional(),
    })
    .optional(),
  createdBy: RuleCreatorSchema,
  createdAt: TimestampSchema,
  rationale: z.string().min(1),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/** The inputs a policy evaluation is run against. */
export const PolicyInputSchema = z.object({
  actionClass: ActionClassSchema,
  counterpartyClass: CounterpartyClassSchema,
  system: SystemSchema,
  confidence: z.number().min(0).max(1).optional(),
  criticPassed: z.boolean().optional(),
  at: TimestampSchema,
  countsToday: z.number().nonnegative().optional(),
  countsThisHour: z.number().nonnegative().optional(),
  // The classifier labels on the observation being evaluated, checked
  // against a rule's `conditions.labelsAnyOf`.
  labels: z.array(z.string().min(1)).optional(),
  // The write target being evaluated, checked against a rule's
  // `conditions.targetAnyOf`.
  target: z.string().min(1).optional(),
  // Whether this evaluation is deciding whether to propose the action, or
  // re-checking an already-approved proposal immediately before execution.
  stage: z.enum(['proposal', 'execution']).default('proposal'),
});
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export const PolicyDecisionSchema = z.object({
  id: UlidSchema,
  decision: DecisionSchema,
  ruleId: UlidSchema.nullable(),
  reason: z.string().min(1),
  input: PolicyInputSchema,
  evaluatedAt: TimestampSchema,
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ProposalSchema = z.object({
  id: UlidSchema,
  correlationId: UlidSchema,
  actionClass: ActionClassSchema,
  counterpartyClass: CounterpartyClassSchema,
  // Spec 5.1 leaves target_system untyped; the policy `system` dimension is
  // the obvious choice, since a proposal always targets one of those systems.
  targetSystem: SystemSchema,
  targetRecordId: z.string().min(1),
  reversibility: ReversibilitySchema,
  payload: JsonRecordSchema,
  preview: z.string().min(1),
  rationale: z.string().min(1),
  provenance: z.array(ProvenanceRefSchema).min(1),
  policyDecision: DecisionSchema,
  // Untyped in spec 5.1; nullable because a `propose`-decision proposal has
  // no matched rule.
  policyRuleId: UlidSchema.nullable(),
  status: ProposalStatusSchema,
  // Untyped in spec 5.1; the obvious shape mirrors the ledger `actor` field.
  decidedBy: ActorSchema.nullable(),
  decidedAt: TimestampSchema.nullable(),
  decisionNote: z.string().nullable(),
  editedPayload: JsonRecordSchema.nullable(),
  slackChannel: z.string().nullable(),
  slackTs: z.string().nullable(),
  expiresAt: TimestampSchema,
  executionEventId: UlidSchema.nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const AlertSchema = z.object({
  id: UlidSchema,
  severity: AlertSeveritySchema,
  kind: AlertKindSchema,
  dedupeKey: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  // Non-negotiable 5: "Every alert ... carries the source system, record id,
  // record hash and observed-at timestamp."
  provenance: z.array(ProvenanceRefSchema).min(1),
  status: AlertStatusSchema,
  firstSeen: TimestampSchema,
  lastSeen: TimestampSchema,
  count: z.int().positive(),
  ackedBy: ActorSchema.nullable(),
  ackedAt: TimestampSchema.nullable(),
  slackTs: z.string().nullable(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const CommitmentSchema = z.object({
  id: UlidSchema,
  direction: CommitmentDirectionSchema,
  // Ontology Person node ids, not relational-table ULIDs, so a plain string.
  ownerPersonId: z.string().min(1),
  counterpartyPersonId: z.string().min(1),
  description: z.string().min(1),
  dueAt: TimestampSchema.nullable(),
  dueConfidence: z.number().min(0).max(1),
  evidenceQuote: z.string(),
  sourceRefs: z.array(ProvenanceRefSchema).min(1),
  status: CommitmentStatusSchema,
  chaseCount: z.int().nonnegative(),
  nextChaseAt: TimestampSchema.nullable(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const AgentRunSchema = z.object({
  id: UlidSchema,
  agent: z.string().min(1),
  version: z.string().min(1),
  model: z.string().min(1),
  started: TimestampSchema,
  // Untyped in spec 5.1; nullable because a running row has not finished yet.
  finished: TimestampSchema.nullable(),
  status: AgentRunStatusSchema,
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  // Untyped in spec 5.1; USD, matching the config price table (spec 13).
  estimatedCost: z.number().nonnegative(),
  traceId: z.string().min(1),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const SystemStateSchema = z.object({
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  pausedBy: ActorSchema.nullable(),
  mode: SystemModeSchema,
  quietHoursStart: HhMmSchema,
  quietHoursEnd: HhMmSchema,
  pushBudgetPerHour: z.int().positive(),
});
export type SystemState = z.infer<typeof SystemStateSchema>;

export const UserSchema = z.object({
  id: UlidSchema,
  upn: z.string().email(),
  slackUserId: z.string().min(1),
  timeZone: z.string().min(1).default('Europe/London'),
  // Untyped in spec 5.1 users table; needed to resolve Dom's Notion user for
  // task Assignee/Contributors writes (ADR 0009).
  notionUserId: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;

export const CursorSchema = z.object({
  watcher: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  updatedAt: TimestampSchema,
});
export type Cursor = z.infer<typeof CursorSchema>;
