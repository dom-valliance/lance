import { FairShareLimiter, type ModelRunner } from '@lance/agents';
import { principals, type Db } from '@lance/db';
import type { Config } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { OffboardDeps } from '../offboarding/offboard.js';
import type { RoleCheckCredentials } from '../roles/roleCheck.js';
import { startBoss } from '../scheduler/boss.js';
import type { ConnectorLookup } from './connectors.js';
import { buildPrincipalContext, type PrincipalContext, type SharedDeps } from './context.js';
import { registerJobHandlers } from './handlers.js';
import { adoptUnscopedJobs } from './adoptUnscoped.js';
import { backfillLegacyGraph } from './legacyGraph.js';
import { cachedOrganisationBudget } from './organisationBudget.js';
import { createReconciler, type ReconcileResult } from './reconcile.js';
import { PrincipalContexts } from './scoped.js';

/**
 * The worker's boot path, apart from the environment: `main.ts` reads
 * config and secrets and calls this, and `boot.test.ts` calls it against a
 * real pg-boss with two principals and fake connectors.
 */

export interface BootOptions {
  config: Config;
  /** Unscoped handle over the worker's pool; pg-boss runs over it too. */
  root: Db;
  boss: PgBoss;
  modelRunner: ModelRunner | null;
  connectorsFor: ConnectorLookup;
  buildWatchers?: SharedDeps['buildWatchers'];
  webUrl: string | null;
  /** For the nightly role check; null skips it (a local run without Entra credentials). */
  roleCheckCredentials: RoleCheckCredentials | null;
  /** How long the organisation budget is cached between model runs; 30 seconds by default. */
  organisationBudgetTtlMs?: number;
  /** Offboarding's vault and Slack halves; both null when omitted, and those steps are skipped. */
  offboarding?: Pick<OffboardDeps, 'secrets' | 'channels'>;
}

export interface BootedWorker {
  contexts: PrincipalContexts<PrincipalContext>;
  reconcile: () => Promise<ReconcileResult>;
  /** The result of the reconcile the boot ran. */
  initial: ReconcileResult;
}

export async function bootWorker(options: BootOptions): Promise<BootedWorker> {
  const { boss, config, root } = options;
  await startBoss(boss);
  // Before any handler or context exists: the legacy graph is its owner's,
  // and a context built first for anyone else must find it layered.
  await backfillLegacyGraph(root, config);
  // Before any handler fetches: jobs a Phase 4 image queued without a
  // principal are given to their owner, or held and alerted on.
  const adoption = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: config.dom.email });
  if (adoption.adopted.length > 0) {
    console.info({ adopted: adoption.adopted.length }, 'jobs queued without a principal adopted');
  }

  const shared: SharedDeps = {
    config,
    root,
    modelRunner: options.modelRunner,
    limiter: new FairShareLimiter({
      concurrency: config.modelLimiter.concurrency,
      burst: config.modelLimiter.principalBurst,
      refillPerMinute: config.modelLimiter.principalRunsPerMinute,
    }),
    checkOrganisationBudget: cachedOrganisationBudget(
      { root, config },
      options.organisationBudgetTtlMs,
    ),
    connectorsFor: options.connectorsFor,
    send: async (queue, data, sendOptions) => {
      await boss.send(queue, data, sendOptions ?? {});
    },
    webUrl: options.webUrl,
    ...(options.buildWatchers === undefined ? {} : { buildWatchers: options.buildWatchers }),
  };
  const contexts = new PrincipalContexts<PrincipalContext>(root, (principal) =>
    buildPrincipalContext(shared, principal),
  );
  const reconcile = createReconciler({
    boss,
    root,
    organisationTimeZone: config.timeZone,
    log: (entry, message) => {
      console.warn(entry, message);
    },
  });

  await registerJobHandlers({
    boss,
    config,
    contexts,
    modelsAvailable: options.modelRunner !== null,
    reconcile,
    root,
    webUrl: options.webUrl,
    roleCheckCredentials: options.roleCheckCredentials,
    offboarding: options.offboarding ?? { secrets: null, channels: null },
    connectorsFor: options.connectorsFor,
  });
  const initial = await reconcile();
  // Every active principal's context is built now rather than at their
  // first job, so the connectors' own start-up checks run at boot, where a
  // failure stops the worker and says why.
  const active = await root
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.status, 'active'));
  for (const principal of active) await contexts.resolve(principal.id);
  return { contexts, reconcile, initial };
}
