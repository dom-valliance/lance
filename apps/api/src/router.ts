import {
  ModeChangeRefusedError,
  type LedgerQuery,
  type ProposalAction,
  type ProposalFilter,
} from '@lance/ledger';
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
  isKnownTimeZone,
} from '@lance/shared';
import { TRPCError } from '@trpc/server';
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
  commitmentSummary,
  getCommitment,
  listCommitments,
  resolveCommitment,
  MAX_PAGE_SIZE,
} from './commitments/service.js';
import { listLedger, MAX_PAGE_SIZE as MAX_LEDGER_PAGE_SIZE } from './ledger/service.js';
import { listProposals, proposalSummary } from './proposals/service.js';
import { OnboardingRefusedError } from './onboarding/service.js';
import { listTasks } from './tasks/service.js';
import { BadRequestError } from './errors.js';
import { adminProcedure, procedure, router, signedInProcedure } from './trpc.js';

/**
 * The tRPC surface `apps/web` calls. `AppRouter` is exported as a type
 * through the package's `./router` entry point so the web app gets end to
 * end types without importing any api runtime code.
 */

const TimestampSchema = z.string().datetime({ offset: true });

/** A `/lance login` token; its shape and MAC are checked by the link service. */
const SlackLinkTokenSchema = z.string().min(1).max(256);

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

/** The Ledger page's filters: the query's, with a page-sized limit and a row cursor. */
export const LedgerListInputSchema = z
  .object({
    kind: LedgerKindSchema.optional(),
    actor: z.string().min(1).optional(),
    sourceSystem: SourceSystemSchema.optional(),
    correlationId: UlidSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    limit: z.int().positive().max(MAX_LEDGER_PAGE_SIZE).optional(),
    /** The id of the oldest event on the previous page. */
    cursor: UlidSchema.optional(),
  })
  .default({});

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

/** The SHA-256 of the data-processing notice the web app rendered, as lowercase hex. */
const NoticeSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be the SHA-256 of the notice as 64 lowercase hex characters');

/**
 * The api's own hash of the notice, after checking the page showed that
 * notice. A client naming any other hash, from a stale page or of its
 * own making, is refused: an acceptance records the text this build
 * carries (docs/plans/multi-user.md M3).
 */
const currentNotice = (ctx: { server: { noticeSha256: string } }, claimed: string): string => {
  if (claimed !== ctx.server.noticeSha256) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'The data-processing notice on this page is not the current one. Reload the page, read the notice it shows, then accept it. Nothing was recorded.',
    });
  }
  return ctx.server.noticeSha256;
};

/** Onboarding step 6: the quiet hours and time zone the principal confirms. */
export const PreferencesInputSchema = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isKnownTimeZone, 'must be a time zone name such as Europe/London'),
  quietHoursStart: HhMmSchema,
  quietHoursEnd: HhMmSchema,
});

/** A refusal written for the principal, passed to the web app with its message intact. */
const precondition = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OnboardingRefusedError || error instanceof ModeChangeRefusedError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
    }
    throw error;
  }
};

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

/** An evidence export's period and optional principal (spec 4.4). */
export const EvidenceInputSchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  principalId: UlidSchema.nullable().default(null),
});

export const OffboardInputSchema = z.object({
  principalId: UlidSchema,
  reason: z.string().trim().min(1).max(500),
  /** Needed to offboard the organisation's owner or the last active Lance.Admin. */
  confirmProtected: z.boolean().optional(),
});

/** A request the admin store refused, as the 400 it is rather than a 500. */
const asBadRequest = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    }
    throw error;
  }
};

export const appRouter = router({
  /**
   * Who is signed in and whether Lance is open to them yet. The one
   * procedure an onboarding principal may call; the web app reads it to
   * decide between the app and the onboarding placeholder.
   */
  me: signedInProcedure.query(({ ctx }) => ({
    principalId: ctx.caller.principal.id,
    upn: ctx.caller.principal.upn,
    status: ctx.caller.principal.status,
    roles: ctx.caller.identity.roles,
  })),
  /**
   * Health, never content (ADR 0024). Each principal's figures are read in
   * that principal's own scope; nothing here returns a proposal, a brief, a
   * commitment, a ledger payload or graph evidence.
   */
  /**
   * The web app's `/link/slack` page (ADR 0021). Open to an onboarding
   * principal, since linking Slack is one of their onboarding steps; the
   * service refuses a paused or offboarded one. The token is the one
   * `/lance login` put in the link, and nothing else travels with it.
   */
  slackLink: router({
    preview: signedInProcedure
      .input(z.object({ token: SlackLinkTokenSchema }))
      .query(({ ctx, input }) => ctx.server.slack.links.preview(input.token, ctx.caller.principal)),
    confirm: signedInProcedure
      .input(z.object({ token: SlackLinkTokenSchema }))
      .mutation(({ ctx, input }) => ctx.server.slack.links.confirm(input.token, ctx.caller)),
    current: signedInProcedure.query(({ ctx }) =>
      ctx.server.slack.links.current(ctx.caller.principal),
    ),
  }),
  /**
   * The onboarding checklist (docs/plans/multi-user.md M3). Open to any
   * signed-in principal so the page can see who is already active and send
   * them on; every write refuses a principal who is not onboarding.
   */
  onboarding: router({
    state: signedInProcedure
      .input(z.object({ noticeSha256: NoticeSha256Schema }))
      .query(({ ctx, input }) =>
        ctx.server.onboarding.state(ctx.caller.principal, currentNotice(ctx, input.noticeSha256)),
      ),
    acceptNotice: signedInProcedure
      .input(z.object({ noticeSha256: NoticeSha256Schema }))
      .mutation(({ ctx, input }) =>
        precondition(() =>
          ctx.server.onboarding.acceptNotice(
            ctx.caller.principal,
            currentNotice(ctx, input.noticeSha256),
            actorFromUpn(ctx.upn),
          ),
        ),
      ),
    confirmPreferences: signedInProcedure
      .input(PreferencesInputSchema)
      .mutation(({ ctx, input }) =>
        precondition(() =>
          ctx.server.onboarding.confirmPreferences(
            ctx.caller.principal,
            input,
            actorFromUpn(ctx.upn),
          ),
        ),
      ),
    complete: signedInProcedure
      .input(z.object({ noticeSha256: NoticeSha256Schema }))
      .mutation(({ ctx, input }) =>
        precondition(() =>
          ctx.server.onboarding.complete(
            ctx.caller.principal,
            currentNotice(ctx, input.noticeSha256),
          ),
        ),
      ),
  }),
  admin: router({
    /** Every principal with their status and which onboarding steps are done. */
    principals: adminProcedure.query(({ ctx }) => ctx.server.admin.principals()),
    /** Watchers, breakers, recorded secrets and cost, per principal. */
    health: adminProcedure.query(({ ctx }) => ctx.server.admin.health()),
    /** Changes to organisation-default rules, newest first. */
    ruleChanges: adminProcedure.query(({ ctx }) => ctx.server.admin.ruleChanges()),
    /** Alerts the organisation jobs raised for this admin. */
    systemAlerts: adminProcedure.query(({ ctx }) =>
      ctx.server.admin.systemAlerts(ctx.caller.principal.id),
    ),
    /**
     * Offboards a principal (docs/runbooks/offboard-principal.md): recorded
     * here, carried out by the worker, which holds the vault and Slack rights.
     */
    offboard: adminProcedure.input(OffboardInputSchema).mutation(({ ctx, input }) =>
      asBadRequest(() =>
        ctx.server.admin.requestOffboarding({
          principalId: input.principalId,
          reason: input.reason,
          actor: ctx.deps.actor,
          callerId: ctx.caller.principal.id,
          ...(input.confirmProtected === undefined
            ? {}
            : { confirmProtected: input.confirmProtected }),
        }),
      ),
    ),
    /**
     * The signed evidence bundle for a period (spec 4.4). A mutation, so the
     * period travels in the request body; without a principal it covers
     * system events only (ADR 0024).
     */
    evidence: adminProcedure.input(EvidenceInputSchema).mutation(({ ctx, input }) => {
      const exporter = ctx.server.evidence;
      if (exporter === undefined) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'The evidence export has no signing key. Set evidence-signing-key in the static Key Vault to an Ed25519 key (docs/compliance/iso27001-access-review.md) and restart the api.',
        });
      }
      return asBadRequest(() =>
        exporter.export({
          from: input.from,
          to: input.to,
          principalId: input.principalId,
          actor: ctx.deps.actor,
          callerId: ctx.caller.principal.id,
        }),
      );
    }),
    /**
     * The organisation kill switch (multi-user plan M5): sets the global
     * row, which pauses every principal. `Lance.Admin` only; the caller's
     * own approved proposals are held at once, everyone else's when their
     * executor next runs.
     */
    pauseAll: adminProcedure
      .input(z.object({ reason: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.deps.control.pauseAll({ reason: input.reason, actor: ctx.deps.actor }),
      ),
    /**
     * Lifts the global pause. Each principal's own pause stays, and proposals
     * held under the global pause are released by that principal's resume.
     */
    resumeAll: adminProcedure.mutation(({ ctx }) =>
      ctx.deps.control.resumeAll({ actor: ctx.deps.actor }),
    ),
    /** The organisation's daily spend ceiling across every principal (M5). */
    organisationCeiling: adminProcedure.query(({ ctx }) =>
      ctx.deps.control.readOrganisation().then((state) => ({
        costCeilingGbp: state.costCeilingGbp,
      })),
    ),
    setOrganisationCeiling: adminProcedure
      .input(z.object({ costCeilingGbp: z.number().positive().max(10_000) }))
      .mutation(({ ctx, input }) =>
        ctx.deps.control.setOrganisationCostCeiling(
          { costCeilingGbp: input.costCeilingGbp },
          { actor: ctx.deps.actor },
        ),
      ),
  }),
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
        precondition(() => ctx.deps.control.setMode(input.mode, { actor: actorFromUpn(ctx.upn) })),
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
    /** The header: how many are pending and the earliest expiry among them. */
    summary: procedure.query(({ ctx }) => proposalSummary(ctx.deps)),
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
    /** Open and overdue counts for both tabs, counted in SQL. */
    summary: procedure.query(({ ctx }) => commitmentSummary(ctx.deps)),
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
    /** The Ledger page: one page of events, the cursor for the next, and the matching total. */
    list: procedure.input(LedgerListInputSchema).query(({ ctx, input }) =>
      listLedger(ctx.deps, {
        ...toLedgerQuery(input),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    ),
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
