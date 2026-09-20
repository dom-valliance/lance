import { createDb } from '@lance/db';
import { SystemControl } from '@lance/ledger';
import { getConfig } from '@lance/shared';
import { noConnectorWrites, registerExecutor } from './executor/index.js';
import { createBoss, startBoss } from './scheduler/boss.js';
import { PauseGate } from './scheduler/gate.js';

async function main(): Promise<void> {
  const config = getConfig();
  const db = createDb();
  const control = new SystemControl(db);
  const gate = new PauseGate(control);
  const boss = createBoss(db);

  boss.on('error', (error: Error) => {
    console.error({ err: error }, 'pg-boss error');
  });

  await startBoss(boss);
  await registerExecutor(boss, { db, gate, write: noConnectorWrites });
  console.info(
    {
      mode: config.mode,
      tickSeconds: config.scheduler.tickSeconds,
      displayName: config.agentDisplayName,
    },
    'worker started',
  );

  const shutdown = async (): Promise<void> => {
    await boss.stop({ graceful: true });
    await db.$client.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
