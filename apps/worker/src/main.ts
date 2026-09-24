import { createAnthropicClient, sdkModelRunner } from '@lance/agents';
import { createDb, scopedDb, waitForPrincipalByUpn } from '@lance/db';
import { getConfig, nowIso, readSecret } from '@lance/shared';
import { initTelemetry } from '@lance/telemetry';
import { bootWorker } from './jobs/boot.js';
import { singleOwnerConnectors, WORKER_VERSION } from './jobs/connectors.js';
import { ensureSeedRules } from './policy/rules.js';
import type { RoleCheckCredentials } from './roles/roleCheck.js';
import { createBoss } from './scheduler/boss.js';

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

/** The Entra app credentials the worker already reads for Graph, or null when any is absent. */
function roleCheckCredentials(): RoleCheckCredentials | null {
  const tenantId = env('ENTRA_TENANT_ID');
  const clientId = env('ENTRA_CLIENT_ID');
  if (tenantId === undefined || clientId === undefined || env('ENTRA_CLIENT_SECRET') === undefined)
    return null;
  return { tenantId, clientId, clientSecret: readSecret('ENTRA_CLIENT_SECRET') };
}

/**
 * The worker's composition root (ADR 0025). It runs every active
 * principal's jobs: each job names its principal, and the job wrapper
 * gives the handler a context scoped to them. Dom's principal, found by
 * UPN, is the admin who receives organisation alerts and seeds the
 * organisation rules until package 5.1 adds roles.
 */
async function main(): Promise<void> {
  const config = getConfig();
  const telemetry = initTelemetry({
    serviceName: 'lance-worker',
    serviceVersion: WORKER_VERSION,
    environment: config.nodeEnv,
  });
  const root = createDb();
  const admin = await waitForPrincipalByUpn(root, config.dom.email, {
    waitSeconds: config.database.startupWaitSeconds,
    log: (message) => {
      console.warn(message);
    },
  });
  const seeded = await ensureSeedRules(
    scopedDb(root, { principalId: admin.id, admin: true }),
    config.slack.channelId,
  );

  const boss = createBoss(root);
  boss.on('error', (error: Error) => {
    console.error({ err: error }, 'pg-boss error');
  });

  const modelRunner =
    env('ANTHROPIC_API_KEY') === undefined ? null : sdkModelRunner(createAnthropicClient(config));
  const worker = await bootWorker({
    config,
    root,
    boss,
    admin,
    modelRunner,
    connectorsFor: singleOwnerConnectors(config),
    webUrl: env('PUBLIC_WEB_URL') ?? null,
    roleCheckCredentials: roleCheckCredentials(),
  });

  console.info(
    {
      mode: config.mode,
      seededRules: seeded.inserted,
      admin: admin.id,
      principals: worker.initial.principals,
      schedules: {
        scheduled: worker.initial.scheduled,
        removed: worker.initial.removed,
        unchanged: worker.initial.unchanged,
      },
      agents: modelRunner !== null,
      displayName: config.agentDisplayName,
      startedAt: nowIso(),
    },
    'worker started',
  );

  const shutdown = async (): Promise<void> => {
    await boss.stop({ graceful: true });
    await root.$client.end();
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
