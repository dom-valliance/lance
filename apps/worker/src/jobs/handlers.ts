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
import { work } from '../scheduler/boss.js';
import { QUEUES } from '../scheduler/queues.js';
import { runTriage } from '../triage/run.js';
import { createAgentLogsDetector } from '../watchers/agent-logs/index.js';
import { runWatcher } from '../watchers/runner.js';
import type { PrincipalContext } from './context.js';
import { runOrganisationBudgetGuard } from './organisationBudget.js';
import type { ReconcileResult } from './reconcile.js';
import {
  ALERT_DELIVERY_QUEUE,
  DIGEST_QUEUE,
  EXPIRY_QUEUE,
  ORGANISATION_BUDGET_QUEUE,
  RECONCILE_QUEUE,
  SYSTEM_JOBS,
} from './registry.js';
import { PrincipalPayloadSchema, workForPrincipal, type PrincipalContexts } from './scoped.js';

/**
 * Every queue the worker consumes, each handler taking its collaborators
 * from the principal's context rather than from closures built once at
 * start-up. Scheduled jobs come from the registry; execute, triage and
 * chase are on demand.
 */

/** Spec 11: the inbox agent's watermark is stale after this many hours without a new line. */
const STALE_WATERMARK_HOURS = 24;
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
}

type PrincipalHandler = (context: PrincipalContext) => Promise<void>;

function detectors(): Detector[] {
  return [
    createAgentLogsDetector({ maxWatermarkAgeHours: STALE_WATERMARK_HOURS }),
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
  for (const detector of detectors()) {
    handlers.set(detectorQueue(detector), async (context) => {
      await runDetector(detector, context.detectors);
    });
  }
  for (const job of SYSTEM_JOBS) {
    if (job.scope !== 'principal' || !job.slug.startsWith('watcher-')) continue;
    handlers.set(job.slug, async (context) => {
      const watcher = context.watchers.get(job.slug);
      if (watcher === undefined) {
        // Connectors are Dom's alone until package 5.2 adds credentials per
        // principal; a principal without them is skipped, never polled with
        // someone else's.
        console.info(
          { queue: job.slug, principalId: context.principal.id, upn: context.principal.upn },
          'watcher run skipped: this principal has no connector credentials for it',
        );
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

async function registerOnDemand(deps: HandlerDeps): Promise<void> {
  const { boss, contexts } = deps;
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
        await boss.send(QUEUES.triage, data, { startAfter: RETRY_WHILE_PAUSED_S });
        return;
      }
      if (context.triage === null) return;
      const { principalId, ...job } = data;
      void principalId;
      await runTriage(context.triage, job);
    },
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
 * Registers a handler for every declared job and every on-demand queue.
 * Throws when the registry declares a job with no handler, so a new
 * declaration cannot be scheduled into a queue nothing consumes.
 */
export async function registerJobHandlers(deps: HandlerDeps): Promise<void> {
  const principal = scheduledHandlers(deps);
  const organisation = organisationHandlers(deps);
  const missing = SYSTEM_JOBS.filter((job) =>
    job.scope === 'principal' ? !principal.has(job.slug) : !organisation.has(job.slug),
  ).map((job) => job.slug);
  if (missing.length > 0) {
    throw new Error(
      `The job registry declares ${missing.join(', ')} with no handler. Add one in apps/worker/src/jobs/handlers.ts.`,
    );
  }
  for (const job of SYSTEM_JOBS) {
    await deps.boss.createQueue(job.slug);
    if (job.scope === 'principal') {
      const handler = principal.get(job.slug);
      if (handler === undefined) continue;
      await workForPrincipal(
        deps.boss,
        job.slug,
        PrincipalPayloadSchema,
        deps.contexts,
        (context) => handler(context),
      );
    } else {
      const handler = organisation.get(job.slug);
      if (handler === undefined) continue;
      await work<unknown>(deps.boss, job.slug, async (jobs) => {
        for (const queued of jobs) await handler(queued.data);
      });
    }
  }
  await registerOnDemand(deps);
}
