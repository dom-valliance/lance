import { createDb } from '@lance/db';
import { OntologyRepository } from './repository.js';

/**
 * `pnpm --filter @lance/ontology rebuild`: empties the graph and replays the
 * ledger's recorded mutations into it (spec 5.2). Connection from the
 * same environment variables the apps use.
 */
async function main(): Promise<void> {
  const db = createDb();
  try {
    const result = await new OntologyRepository(db).rebuild();
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
