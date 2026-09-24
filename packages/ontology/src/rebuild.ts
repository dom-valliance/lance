import { createDb } from '@lance/db';
import { rebuildGraph } from './repository.js';

/**
 * `pnpm --filter @lance/ontology rebuild`: empties the graph and replays
 * every principal's recorded mutations into it in ledger order (spec 5.2).
 * The ledger is per principal (ADR 0015), so the rebuild reads each active
 * and paused principal through its own scope over this one pool.
 * Connection from the same environment variables the apps use.
 */
async function main(): Promise<void> {
  const db = createDb();
  try {
    const result = await rebuildGraph(db);
    console.info(
      `Rebuilt lance_ontology from the ledger: ${String(result.replayed)} mutations replayed, ${String(result.nodes)} nodes, ${String(result.edges)} edges.`,
    );
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
