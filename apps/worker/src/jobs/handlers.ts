import type { Db } from '@lance/db';
import { expireProposals } from '@lance/ledger';
import { UlidSchema, type Config } from '@lance/shared';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { allDetectors } from '../alerts/detectors/index.js';
import type { Detector } from '../alerts/detectors/types.js';
import { deliverAlerts } from '../alerts/engine/deliver.js';
import { detectorQueue, runDetector } from '../alerts/engine/run.js';
import {
  QUEUE_BOARD,
  QUEUE_MORNING,
  QUEUE_PREP,
  runAfternoonBoard,
  runMeetingPrep,
  runMorningBrief,
} from '../briefs/run.js';
import { QUEUE_WEEKLY, runWeeklyReview } from '../briefs/weekly.js';
import { runChase } from '../chase/run.js';
import { postDryRunDigest } from '../digest/dryRunDigest.js';
import { executeProposal } from '../executor/index.js';
import { reflectProposal } from '../executor/reflect.js';
import { work, type WorkQueueOptions } from '../scheduler/boss.js';
import { QUEUES } from '../scheduler/queues.js';
import { fileBulkMail } from '../triage/bulk.js';
import { runTriage } from '../triage/run.js';
import { createAgentLogsDetector, watermarkThreshold } from '../watchers/agent-logs/index.js';
import { runWatcher } from '../watchers/runner.js';
import { runOnboardingPrefill } from '../onboarding/prefill.js';
import { connectorOfWatcher, type ConnectorLookup } from './connectors.js';
import type { PrincipalContext } from './context.js';
import { runRoleCheck, type RoleCheckCredentials } from '../roles/roleCheck.js';
import {
  OFFBOARD_QUEUE,
  offboardPrincipal,
  type OffboardDeps,
  type OffboardResult,
} from '../offboarding/offboard.js';
import { runRetention } from '../retention/run.js';
import { runOrganisationBudgetGuard } from './organisationBudget.js';
import type { ReconcileResult } from './reconcile.js';
import {
  ALERT_DELIVERY_QUEUE,
  DIGEST_QUEUE,
  EXPIRY_QUEUE,
  ONBOARDING_PREFILL_QUEUE,
  ORGANISATION_BUDGET_QUEUE,
  RECONCILE_QUEUE,
  RETENTION_QUEUE,
  ROLE_CHECK_QUEUE,
  SYSTEM_JOBS,
  type JobDeclaration,
} from './registry.js';
import {
  PrincipalPayloadSchema,
  principalJobOptions,
  workForPrincipal,
  type PrincipalContexts,
} from './scoped.js';

/**
 * Every queue the worker consumes, each handler taking its collaborators
 * from the principal's context rather than from closures built once at
 * start-up. Scheduled jobs come from the registry; execute, triage and
 * chase are on demand.
 */

/** Spec 11: the inbox agent's watermark is stale after this many hours without a new line. */
/** How long a triage or chase job waits before it is looked at again while paused. */
const RETRY_WHILE_PAUSED_S = 60;

export const ExecutePayloadSchema = z.object({
  principalId: UlidSchema,
  proposalId: UlidSchema,
});

export const TriagePayloadSchema = z.object({
  principalId: UlidSchema,
  watcher: z.string().min(1),
  correlationId: UlidSchema,
  observationEventIds: z.array(UlidSchema),
});

export const ChasePayloadSchema = z.object({
  principalId: UlidSchema,
  commitmentId: UlidSchema,
});

/** What the admin page's offboard action and the role check put on the queue. */
export const OffboardPayloadSchema = z.object({
  principalId: UlidSchema,
  actor: z.string().min(1),
  reason: z.string().min(1),
});

/** What the api may add when it asks for a reconcile, for the log line. */
const ReconcilePayloadSchema = z.object({ principalId: UlidSchema.optional() }).passthrough();

export interface HandlerDeps {
  boss: PgBoss;
  config: Config;
  contexts: PrincipalContexts<PrincipalContext>;
  /** Whether a model is configured; without one triage and chase jobs wait on the queue. */
  modelsAvailable: boolean;
  reconcile: () => Promise<ReconcileResult>;
  /** The admin's scoped handle, where organisation alerts land (Dom until package 5.1). */
  adminDb: Db;
  root: Db;
  webUrl: string | null;
  /**
   * The app's own Entra client credentials for the nightly role check;
   * null in a process without them, such as a local run, where the check
   * skips with a log line.
   */
  roleCheckCredentials: RoleCheckCredentials | null;
  /**
   * Where offboarding deletes secrets and archives channels (package 5.6).
   * Each half is null in a process without the principal vault or a Slack
   * bot token, and the step is then recorded as skipped.
   */
  offboarding: Pick<OffboardDeps, 'secrets' | 'channels'>;
  /** Each principal's connectors, for the onboarding prefill's mailbox read. */
  connectorsFor: ConnectorLookup;
}

type PrincipalHandler = (context: PrincipalContext) => Promise<void>;

/**
 * A watcher run for a principal without the connector it needs (ADR 0022):
 * recorded as skipped, naming the secret that is missing, and never run
 * with anyone else's credentials. When the secret has appeared since the
 * principal's context was built (they connected in the meantime), the
 * context is dropped so the next job rebuilds it with the new connector.
 */
export async function recordSkippedWatcherRun(
  deps: Pick<HandlerDeps, 'contexts'>,
  context: PrincipalContext,
  slug: string,
): Promise<void> {
  const connector = connectorOfWatcher(slug);
  const gap = context.connectors?.notConnected.find((entry) => entry.connector === connector);
  console.info(
    {
      queue: slug,
      principalId: context.principal.id,
      status: 'skipped',
      connector,
      missing: gap?.missing ?? null,
    },
    gap === undefined
      ? `watcher run skipped: this process has no ${connector ?? 'connector'} configured for the principal`
      : `watcher run skipped: ${gap.connector} is not connected for this principal; the secret ${gap.missing} is absent`,
  );
  if (gap !== undefined && (await gap.recheck())) {
    deps.contexts.evict(context.principal.id);
  }
}

function detectors(config: Config): Detector[] {
  return [
    createAgentLogsDetector({ maxWatermarkAgeHours: watermarkThreshold(config.inboxAgent) }),
    ...allDetectors(),
  ];
}

/** The handler for each per-principal scheduled job, by slug. */
function scheduledHandlers(deps: HandlerDeps): Map<string, PrincipalHandler> {
  const handlers = new Map<string, PrincipalHandler>([
    [
      EXPIRY_QUEUE,
      async (context) => {
        const expired = await expireProposals(context.db);
        if (expired.length > 0) {
          console.info(
            { expired: expired.length, principalId: context.principal.id },
            'proposals expired',
          );
        }
      },
    ],
    [
      DIGEST_QUEUE,
      async (context) => {
        // One message at 17:00 on weekdays while in dry run (spec 6.3).
        const state = await context.control.read();
        if (state.mode !== 'dry_run') return;
        const since = new Date(Date.now() - 24 * 3600 * 1000);
        await postDryRunDigest(context.db, context.slack, {
          since,
          displayName: deps.config.agentDisplayName,
        });
      },
    ],
    [
      ALERT_DELIVERY_QUEUE,
      async (context) => {
        // Paused is not silent: P0 still goes out, everything else waits (spec 9.4).
        const paused = !(await context.gate.check()).runnable;
        await deliverAlerts({
          db: context.db,
          config: deps.config,
          slack: context.slack,
          webUrl: deps.webUrl,
          paused,
          control: context.control,
        });
      },
    ],
    [
      QUEUE_MORNING,
      async (context) => {
        await runMorningBrief(context.briefs);
      },
    ],
    [
      QUEUE_BOARD,
      async (context) => {
        await runAfternoonBoard(context.briefs);
      },
    ],
    [
      QUEUE_PREP,
      async (context) => {
        await runMeetingPrep(context.briefs);
      },
    ],
    [
      QUEUE_WEEKLY,
      async (context) => {
        await runWeeklyReview(context.weekly);
      },
    ],
  ]);
  for (const detector of detectors(deps.config)) {
    handlers.set(detectorQueue(detector), async (context) => {
      await runDetector(detector, context.detectors);
    });
  }
  for (const job of SYSTEM_JOBS) {
    if (job.scope !== 'principal' || !job.slug.startsWith('watcher-')) continue;
    handlers.set(job.slug, async (context) => {
      const watcher = context.watchers.get(job.slug);
      if (watcher === undefined) {
        await recordSkippedWatcherRun(deps, context, job.slug);
        return;
      }
      await runWatcher(context.runner, watcher);
    });
  }
  return handlers;
}

/** The handler for each organisation job, by slug. */
function organisationHandlers(deps: HandlerDeps): Map<string, (data: unknown) => Promise<void>> {
  return new Map([
    [
      RECONCILE_QUEUE,
      async (data: unknown) => {
        const requested = ReconcilePayloadSchema.safeParse(data);
        const result = await deps.reconcile();
        if (result.scheduled > 0 || result.removed > 0) {
          console.info(
            {
              ...result,
              requestedBy: requested.success ? (requested.data.principalId ?? null) : null,
            },
            'job schedules reconciled',
          );
        }
      },
    ],
    [
      ROLE_CHECK_QUEUE,
      async () => {
        if (deps.roleCheckCredentials === null) {
          console.info(
            { queue: ROLE_CHECK_QUEUE },
            'role check skipped: ENTRA_TENANT_ID, ENTRA_CLIENT_ID or ENTRA_CLIENT_SECRET is not set',
          );
          return;
        }
        const result = await runRoleCheck({
          root: deps.root,
          credentials: deps.roleCheckCredentials,
          offboarding: {
            afterDays: deps.config.offboarding.afterRoleLossDays,
            run: (request) => offboard(deps, request),
          },
        });
        console.info(
          {
            paused: result.paused.map((principal) => principal.principalId),
            unbound: result.unbound,
            alerted: result.alerted,
            offboarded: result.offboarded,
          },
          'role check finished',
        );
      },
    ],
    [
      ONBOARDING_PREFILL_QUEUE,
      async () => {
        const result = await runOnboardingPrefill({
          root: deps.root,
          connectorsFor: deps.connectorsFor,
        });
        if (result.read.length > 0 || result.failed.length > 0) {
          console.info(result, 'onboarding prefill finished');
        }
      },
    ],
    [
      ORGANISATION_BUDGET_QUEUE,
      async () => {
        await runOrganisationBudgetGuard({
          root: deps.root,
          config: deps.config,
          adminDb: deps.adminDb,
        });
      },
    ],
  ]);
}

/** Offboards one principal and logs the outcome of each step, never its detail. */
async function offboard(
  deps: HandlerDeps,
  request: z.infer<typeof OffboardPayloadSchema>,
): Promise<OffboardResult> {
  deps.contexts.evict(request.principalId);
  const result = await offboardPrincipal(
    { root: deps.root, config: deps.config, ...deps.offboarding },
    request,
  );
  deps.contexts.evict(request.principalId);
  console.info(
    {
      principalId: result.principalId,
      correlationId: result.correlationId,
      steps: result.steps.map((step) => `${step.step}:${step.outcome}`),
    },
    'principal offboarded',
  );
  // Their schedules go at once rather than at the next minute's reconcile.
  await deps.reconcile();
  return result;
}

/**
 * Jobs declared for every status (retention): the payload names the
 * principal, who must exist, and the handler runs whatever their status,
 * over a handle it scopes itself, without building their connectors.
 */
async function registerEveryStatus(deps: HandlerDeps): Promise<void> {
  await work<unknown>(deps.boss, RETENTION_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { principalId } = PrincipalPayloadSchema.parse(job.data);
      const result = await runRetention({
        root: deps.root,
        config: deps.config,
        principalId,
        trigger: 'nightly',
      });
      console.info({ principalId, counts: result.counts }, 'retention applied');
    }
  });
}

async function registerOnDemand(deps: HandlerDeps): Promise<void> {
  const { boss, contexts } = deps;
  await boss.createQueue(OFFBOARD_QUEUE);
  await work<unknown>(boss, OFFBOARD_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await offboard(deps, OffboardPayloadSchema.parse(job.data));
    }
  });
  await workForPrincipal(
    boss,
    QUEUES.execute,
    ExecutePayloadSchema,
    contexts,
    async (context, data) => {
      const outcome = await executeProposal(context.executor, { proposalId: data.proposalId });
      await reflectProposal(context.reflect, data.proposalId, outcome);
    },
  );
  // Bulk mail needs no model (ADR 0034), so it is filed whether or not
  // this process has one.
  await workForPrincipal(
    boss,
    QUEUES.bulkMail,
    TriagePayloadSchema,
    contexts,
    async (context, data) => {
      if (!(await context.gate.check()).runnable) {
        await boss.send(QUEUES.bulkMail, data, {
          startAfter: RETRY_WHILE_PAUSED_S,
          ...principalJobOptions(data.principalId),
        });
        return;
      }
      const { principalId, ...job } = data;
      void principalId;
      await fileBulkMail(context.bulkMail, job);
    },
    bulkMailQueueOptions(),
  );
  // Without a model there is no consumer, so triage and chase jobs wait on
  // the queue for a worker that has one, as they did before Phase 5.
  if (!deps.modelsAvailable) return;
  await workForPrincipal(
    boss,
    QUEUES.triage,
    TriagePayloadSchema,
    contexts,
    async (context, data) => {
      if (!(await context.gate.check()).runnable) {
        // Paused: the job is put back for later rather than dropped, so a
        // pause during a busy tick loses no triage (non-negotiable 6).
        await boss.send(QUEUES.triage, data, {
          startAfter: RETRY_WHILE_PAUSED_S,
          ...principalJobOptions(data.principalId),
        });
        return;
      }
      if (context.triage === null) return;
      const { principalId, ...job } = data;
      void principalId;
      await runTriage(context.triage, job);
    },
    modelQueueOptions(deps.config),
  );
  await workForPrincipal(
    boss,
    QUEUES.chase,
    ChasePayloadSchema,
    contexts,
    async (context, data) => {
      if (!(await context.gate.check()).runnable) {
        await boss.send(QUEUES.chase, data, { startAfter: RETRY_WHILE_PAUSED_S });
        return;
      }
      if (context.chase === null) return;
      const result = await runChase(context.chase, { commitmentId: data.commitmentId });
      if (result.status === 'refused') {
        console.warn(
          { commitmentId: data.commitmentId, principalId: data.principalId, reason: result.reason },
          'chase refused',
        );
      }
    },
  );
}

/**
 * How often a per-principal queue's worker fetches. Every principal's
 * alert delivery falls in the same minute; at pg-boss's default of one
 * fetch every two seconds, thirty principals' deliveries took the whole
 * minute in the load test, and a thirty-first would fall behind for good
 * (docs/runbooks/load-test.md). pg-boss allows no shorter interval.
 */
export const PRINCIPAL_QUEUE_POLL_SECONDS = 0.5;

/**
 * Bulk-mail jobs are a few database writes each, so four run at once and
 * a Monday's newsletters for thirty principals clear in seconds rather
 * than at one a fetch; still one per principal at a time.
 */
export const BULK_MAIL_CONCURRENCY = 4;

export function bulkMailQueueOptions(): WorkQueueOptions {
  return {
    localConcurrency: BULK_MAIL_CONCURRENCY,
    localGroupConcurrency: 1,
    pollingIntervalSeconds: PRINCIPAL_QUEUE_POLL_SECONDS,
  };
}

/**
 * The pg-boss worker options for a queue whose jobs wait on the model
 * (load-test option A, ADR 0034): `config.modelQueues.concurrency` jobs at
 * once, so the model limiter's slots are used, and never two of one
 * principal's, so two polls of one mailbox never label the same messages
 * and one principal's backlog cannot hold every worker.
 */
export function modelQueueOptions(config: Pick<Config, 'modelQueues'>): WorkQueueOptions {
  return {
    localConcurrency: config.modelQueues.concurrency,
    localGroupConcurrency: 1,
    pollingIntervalSeconds: PRINCIPAL_QUEUE_POLL_SECONDS,
  };
}

/**
 * The pg-boss worker options for one per-principal scheduled job. Every
 * such queue runs at most one job per principal at a time (its group, see
 * `principalJobOptions`), whatever its concurrency.
 */
export function principalQueueOptions(
  job: Pick<JobDeclaration, 'concurrency' | 'modelBound'>,
  config: Pick<Config, 'modelQueues'>,
): WorkQueueOptions {
  if (job.modelBound) return modelQueueOptions(config);
  return {
    localConcurrency: job.concurrency,
    localGroupConcurrency: 1,
    pollingIntervalSeconds: PRINCIPAL_QUEUE_POLL_SECONDS,
  };
}

/**
 * Registers a handler for every declared job and every on-demand queue.
 * Throws when the registry declares a job with no handler, so a new
 * declaration cannot be scheduled into a queue nothing consumes.
 */
export async function registerJobHandlers(deps: HandlerDeps): Promise<void> {
  const principal = scheduledHandlers(deps);
  const organisation = organisationHandlers(deps);
  const missing = SYSTEM_JOBS.filter((job) =>
    job.everyStatus
      ? job.slug !== RETENTION_QUEUE
      : job.scope === 'principal'
        ? !principal.has(job.slug)
        : !organisation.has(job.slug),
  ).map((job) => job.slug);
  if (missing.length > 0) {
    throw new Error(
      `The job registry declares ${missing.join(', ')} with no handler. Add one in apps/worker/src/jobs/handlers.ts.`,
    );
  }
  for (const job of SYSTEM_JOBS) {
    await deps.boss.createQueue(job.slug);
    if (job.everyStatus) continue;
    if (job.scope === 'principal') {
      const handler = principal.get(job.slug);
      if (handler === undefined) continue;
      await workForPrincipal(
        deps.boss,
        job.slug,
        PrincipalPayloadSchema,
        deps.contexts,
        (context) => handler(context),
        principalQueueOptions(job, deps.config),
      );
    } else {
      const handler = organisation.get(job.slug);
      if (handler === undefined) continue;
      await work<unknown>(deps.boss, job.slug, async (jobs) => {
        for (const queued of jobs) await handler(queued.data);
      });
    }
  }
  await registerEveryStatus(deps);
  await registerOnDemand(deps);
}
