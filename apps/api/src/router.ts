import type { LedgerQuery, ProposalAction, ProposalFilter } from '@lance/ledger';
import {
  ActionClassSchema,
  AlertSeveritySchema,
  AlertStatusSchema,
  BriefKindSchema,
  CommitmentDirectionSchema,
  CommitmentStatusSchema,
  CostCeilingInputSchema,
  CounterpartyClassSchema,
  LedgerKindSchema,
  ProposalStatusSchema,
  SourceSystemSchema,
  SystemModeSchema,
  SystemSchema,
  UlidSchema,
} from '@lance/shared';
import { z } from 'zod';
import { actorFromUpn } from './actor.js';
import {
  ackAlert,
  getAlert,
  listAlerts,
  muteAlert,
  resolveAlert,
  MAX_MUTE_HOURS,
  MIN_MUTE_HOURS,
} from './alerts/service.js';
import { agentsStatus } from './agents/service.js';
import {
  getBrief,
  latestBrief,
  listBriefs,
  MAX_PAGE_SIZE as MAX_BRIEF_PAGE_SIZE,
} from './briefs/service.js';
import { resumeAndRequeue } from './deps.js';
import {
  chaseCommitment,
  getCommitment,
  listCommitments,
  resolveCommitment,
  MAX_PAGE_SIZE,
} from './commitments/service.js';
import { listProposals } from './proposals/service.js';
import { listTasks } from './tasks/service.js';
import { procedure, router } from './trpc.js';

/**
 * The tRPC surface `apps/web` calls. `AppRouter` is exported as a type
 * through the package's `./router` entry point so the web app gets end to
 * end types without importing any api runtime code.
 */

const TimestampSchema = z.string().datetime({ offset: true });

/** Mirrors `LedgerQuery` from `@lance/ledger`, validated at the boundary. */
export const LedgerQueryInputSchema = z
  .object({
    kind: LedgerKindSchema.optional(),
    actor: z.string().min(1).optional(),
    sourceSystem: SourceSystemSchema.optional(),
    correlationId: UlidSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    limit: z.int().positive().max(2000).optional(),
  })
  .default({});
export type LedgerQueryInput = z.infer<typeof LedgerQueryInputSchema>;

/**
 * Copies only the keys that were supplied. `exactOptionalPropertyTypes`
 * rejects an explicit `undefined`, and a spread would carry one for every
 * omitted filter.
 */
export const toLedgerQuery = (input: LedgerQueryInput): LedgerQuery => {
  const query: LedgerQuery = {};
  if (input.kind !== undefined) query.kind = input.kind;
  if (input.actor !== undefined) query.actor = input.actor;
  if (input.sourceSystem !== undefined) query.sourceSystem = input.sourceSystem;
  if (input.correlationId !== undefined) query.correlationId = input.correlationId;
  if (input.from !== undefined) query.from = input.from;
  if (input.to !== undefined) query.to = input.to;
  if (input.limit !== undefined) query.limit = input.limit;
  return query;
};

/** Mirrors `ProposalFilter` from `@lance/ledger`. */
export const ProposalFilterInputSchema = z
  .object({
    status: ProposalStatusSchema.optional(),
    actionClass: ActionClassSchema.optional(),
    counterpartyClass: CounterpartyClassSchema.optional(),
    targetSystem: SystemSchema.optional(),
    limit: z.int().positive().max(200).optional(),
    cursor: UlidSchema.optional(),
  })
  .default({});
export type ProposalFilterInput = z.infer<typeof ProposalFilterInputSchema>;

export const toProposalFilter = (input: ProposalFilterInput): ProposalFilter => {
  const filter: ProposalFilter = {};
  if (input.status !== undefined) filter.status = input.status;
  if (input.actionClass !== undefined) filter.actionClass = input.actionClass;
  if (input.counterpartyClass !== undefined) filter.counterpartyClass = input.counterpartyClass;
  if (input.targetSystem !== undefined) filter.targetSystem = input.targetSystem;
  if (input.limit !== undefined) filter.limit = input.limit;
  if (input.cursor !== undefined) filter.cursor = input.cursor;
  return filter;
};

/**
 * Every value of `ProposalAction`. `satisfies` makes this a compile error
 * the day the ledger's state machine gains an action this router has not
 * been taught, rather than a runtime rejection of a valid decision.
 */
const PROPOSAL_ACTIONS = {
  approve: 'approve',
  edit: 'edit',
  reject: 'reject',
  snooze: 'snooze',
  expire: 'expire',
  hold: 'hold',
} as const satisfies Record<ProposalAction, ProposalAction>;

export const ProposalActionSchema = z.enum(PROPOSAL_ACTIONS);

/**
 * The decision input. `actor` is deliberately absent: it is derived from
 * the verified UPN inside the procedure, so a client cannot decide as
 * somebody else.
 */
export const DecideInputSchema = z.object({
  proposalId: UlidSchema,
  action: ProposalActionSchema,
  note: z.string().min(1).optional(),
  reasonCode: z.string().min(1).optional(),
  editedPayload: z.record(z.string(), z.unknown()).optional(),
  snoozeHours: z.int().positive().max(168).optional(),
});
export type DecideInput = z.infer<typeof DecideInputSchema>;

/** The Commitments page's two tabs and its filters (spec 12). */
export const CommitmentListInputSchema = z
  .object({
    direction: CommitmentDirectionSchema.optional(),
    status: CommitmentStatusSchema.optional(),
    limit: z.int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: UlidSchema.optional(),
  })
  .default({});
export type CommitmentListInput = z.infer<typeof CommitmentListInputSchema>;

/** The Tasks page's source badges and its open or done filter (spec 12). */
export const TaskListInputSchema = z
  .object({
    source: z.enum(['notion', 'jamie']).optional(),
    status: z.enum(['open', 'done']).optional(),
    limit: z.int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: UlidSchema.optional(),
  })
  .default({});
export type TaskListInput = z.infer<typeof TaskListInputSchema>;

/** `HH:MM`, 24-hour, as the quiet-hours columns store it. */
const HhMmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM" in 24-hour time');

/** The Settings page's interruption budget (spec 9.1). */
export const InterruptionBudgetInputSchema = z.object({
  quietHoursStart: HhMmSchema,
  quietHoursEnd: HhMmSchema,
  pushBudgetPerHour: z.int().min(0).max(50),
});
export type InterruptionBudgetInput = z.infer<typeof InterruptionBudgetInputSchema>;

/** The Alerts page's three tabs and its filters (spec 12). */
export const AlertListInputSchema = z
  .object({
    status: AlertStatusSchema.optional(),
    severity: AlertSeveritySchema.optional(),
    // The kind column is free text, so the filter takes the string the page
    // read off a row rather than the union the watchers happen to write.
    kind: z.string().min(1).optional(),
    limit: z.int().positive().max(MAX_PAGE_SIZE).optional(),
    cursor: UlidSchema.optional(),
  })
  .default({});
export type AlertListInput = z.infer<typeof AlertListInputSchema>;

/** `YYYY-MM-DD`, the local day the Today page is showing. */
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as "YYYY-MM-DD"');

/** The Today page's brief history (spec 12, Today row). */
export const BriefListInputSchema = z
  .object({
    kind: BriefKindSchema.optional(),
    limit: z.int().positive().max(MAX_BRIEF_PAGE_SIZE).optional(),
    cursor: UlidSchema.optional(),
  })
  .default({});
export type BriefListInput = z.infer<typeof BriefListInputSchema>;

export const appRouter = router({
  systemState: router({
    get: procedure.query(({ ctx }) => ctx.deps.control.read()),
    /** The same payload as `GET /admin/status`: pause, mode, cursors, cost. */
    status: procedure.query(({ ctx }) => ctx.deps.status.snapshot()),
    pause: procedure
      .input(z.object({ reason: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.deps.control.pause({ reason: input.reason, actor: actorFromUpn(ctx.upn) }),
      ),
    /** Releases every held proposal and puts each one back on the execute queue. */
    resume: procedure.mutation(({ ctx }) => resumeAndRequeue(ctx.deps)),
    setMode: procedure
      .input(z.object({ mode: SystemModeSchema }))
      .mutation(({ ctx, input }) =>
        ctx.deps.control.setMode(input.mode, { actor: actorFromUpn(ctx.upn) }),
      ),
    setInterruptionBudget: procedure
      .input(InterruptionBudgetInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.deps.control.setInterruptionBudget(input, { actor: actorFromUpn(ctx.upn) }),
      ),
    /** Spec 13: the daily model spend ceiling; model-backed agents stop at it until midnight or until it is raised. */
    setCostCeiling: procedure
      .input(CostCeilingInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.deps.control.setCostCeiling(input, { actor: actorFromUpn(ctx.upn) }),
      ),
  }),
  settings: router({
    /** The retention windows the Settings page shows (spec 16, Q3). */
    retention: procedure.query(({ ctx }) => ctx.deps.config.retention),
  }),
  briefs: router({
    /** The newest brief of a kind generated on a local day, today by default. */
    latest: procedure
      .input(z.object({ kind: BriefKindSchema, date: LocalDateSchema.optional() }))
      .query(({ ctx, input }) =>
        latestBrief(ctx.deps, {
          kind: input.kind,
          ...(input.date === undefined ? {} : { date: input.date }),
        }),
      ),
    list: procedure
      .input(BriefListInputSchema)
      .query(({ ctx, input }) => listBriefs(ctx.deps, input)),
    get: procedure
      .input(z.object({ id: UlidSchema }))
      .query(({ ctx, input }) => getBrief(ctx.deps, input.id)),
    /**
     * Queues a fresh morning brief on the worker's queue, the same path as
     * `/lance brief`. Nothing is generated here: the worker writes the
     * brief and the Today page re-reads it.
     */
    regenerate: procedure.mutation(async ({ ctx }) => ({
      enqueued: true as const,
      jobId: await ctx.deps.enqueueBrief(),
    })),
  }),
  proposals: router({
    list: procedure
      .input(ProposalFilterInputSchema)
      .query(({ ctx, input }) => listProposals(ctx.deps, toProposalFilter(input))),
    get: procedure
      .input(z.object({ proposalId: UlidSchema }))
      .query(({ ctx, input }) => ctx.deps.proposals.get(input.proposalId)),
    decide: procedure.input(DecideInputSchema).mutation(({ ctx, input }) =>
      ctx.deps.decide({
        proposalId: input.proposalId,
        action: input.action,
        actor: actorFromUpn(ctx.upn),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
        ...(input.editedPayload === undefined ? {} : { editedPayload: input.editedPayload }),
        ...(input.snoozeHours === undefined ? {} : { snoozeHours: input.snoozeHours }),
      }),
    ),
  }),
  commitments: router({
    list: procedure
      .input(CommitmentListInputSchema)
      .query(({ ctx, input }) => listCommitments(ctx.deps, input)),
    get: procedure
      .input(z.object({ id: UlidSchema }))
      .query(({ ctx, input }) => getCommitment(ctx.deps, input.id)),
    markDone: procedure
      .input(z.object({ id: UlidSchema }))
      .mutation(({ ctx, input }) =>
        resolveCommitment(ctx.deps, { id: input.id, to: 'done', actor: actorFromUpn(ctx.upn) }),
      ),
    drop: procedure
      .input(z.object({ id: UlidSchema, reason: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        resolveCommitment(ctx.deps, {
          id: input.id,
          to: 'dropped',
          reason: input.reason,
          actor: actorFromUpn(ctx.upn),
        }),
      ),
    /** Queues the draft; the worker writes it and it arrives as a proposal. */
    chase: procedure
      .input(z.object({ id: UlidSchema }))
      .mutation(({ ctx, input }) => chaseCommitment(ctx.deps, input.id, actorFromUpn(ctx.upn))),
  }),
  alerts: router({
    list: procedure
      .input(AlertListInputSchema)
      .query(({ ctx, input }) => listAlerts(ctx.deps, input)),
    get: procedure
      .input(z.object({ id: UlidSchema }))
      .query(({ ctx, input }) => getAlert(ctx.deps, input.id)),
    ack: procedure
      .input(z.object({ id: UlidSchema }))
      .mutation(({ ctx, input }) =>
        ackAlert(ctx.deps, { id: input.id, actor: actorFromUpn(ctx.upn) }),
      ),
    mute: procedure
      .input(z.object({ id: UlidSchema, hours: z.int().min(MIN_MUTE_HOURS).max(MAX_MUTE_HOURS) }))
      .mutation(({ ctx, input }) =>
        muteAlert(ctx.deps, { id: input.id, hours: input.hours, actor: actorFromUpn(ctx.upn) }),
      ),
    resolve: procedure
      .input(z.object({ id: UlidSchema }))
      .mutation(({ ctx, input }) =>
        resolveAlert(ctx.deps, { id: input.id, actor: actorFromUpn(ctx.upn) }),
      ),
  }),
  agents: router({
    /** Watchers, agents, cost and breakers in one read (spec 12, Agents row). */
    status: procedure.query(({ ctx }) => agentsStatus(ctx.deps)),
  }),
  tasks: router({
    list: procedure
      .input(TaskListInputSchema)
      .query(({ ctx, input }) => listTasks(ctx.deps, input)),
  }),
  ledger: router({
    query: procedure
      .input(LedgerQueryInputSchema)
      .query(({ ctx, input }) => ctx.deps.ledger.query(toLedgerQuery(input))),
    byCorrelation: procedure
      .input(z.object({ correlationId: UlidSchema }))
      .query(({ ctx, input }) => ctx.deps.ledger.byCorrelation(input.correlationId)),
    /** One correlation id's trail, oldest first: the same read, named for what the UI shows. */
    correlation: procedure
      .input(z.object({ correlationId: UlidSchema }))
      .query(({ ctx, input }) => ctx.deps.ledger.byCorrelation(input.correlationId)),
  }),
});

export type AppRouter = typeof appRouter;
