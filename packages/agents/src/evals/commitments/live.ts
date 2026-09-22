/**
 * Runs the commitment extraction eval against the real model:
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @lance/agents eval:commitments:live
 *
 * This is the Phase 2 acceptance evidence (spec 15: F1 above 0.8 on the
 * golden set). Runs are recorded in memory only; nothing touches Postgres.
 * EVAL_FILTER and EVAL_MIN_F1 behave as in cli.ts.
 */
import { loadConfig, newUlid } from '@lance/shared';
import { createAnthropicClient, sdkModelRunner } from '../../client.js';
import { createCommitmentExtractor } from '../../commitments/extract.js';
import { MemoryRunRecorder } from '../../testing.js';
import type { CommitmentFixture } from './fixtures.js';
import { COMMITMENTS_FIXTURES_DIR, formatReport, runCommitmentEval } from './run.js';

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: process.env['NODE_ENV'] ?? 'development',
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://unused:unused@localhost:5432/unused',
  });
  const client = createAnthropicClient(config);
  const extractor = createCommitmentExtractor({
    agent: {
      runner: sdkModelRunner(client),
      recorder: new MemoryRunRecorder(),
      ledger: { append: () => Promise.resolve({ id: newUlid() }) },
      config: { prices: config.prices, cost: config.cost },
      readSpendUsd: () => Promise.resolve(0),
    },
    model: config.models.triage,
    displayName: config.agentDisplayName,
  });

  const filter = process.env['EVAL_FILTER'];
  const result = await runCommitmentEval({
    extract: (record: CommitmentFixture) =>
      extractor(
        {
          id: record.id,
          kind: record.kind,
          dom: record.dom,
          participants: record.participants,
          occurredAt: null,
          text: record.text,
        },
        newUlid(),
      ),
    fixturesDir: COMMITMENTS_FIXTURES_DIR,
    ...(filter === undefined || filter === ''
      ? {}
      : { filter: (record) => record.id.includes(filter) }),
  });
  console.info(formatReport(result));

  const floor = Number(process.env['EVAL_MIN_F1'] ?? '0.8');
  if (result.totals.f1 < floor) {
    console.error(`F1 ${result.totals.f1.toFixed(3)} is below the floor of ${String(floor)}.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
