import { createDb, principals, scopedDb } from '@lance/db';
import { eq } from 'drizzle-orm';
import {
  dropTranscriptDuplicates,
  findTranscriptDuplicates,
  restoreTranscriptDuplicates,
} from './transcriptDuplicates.js';

/**
 * Lists, drops or restores the commitments recorded twice from one meeting
 * transcript, for every active principal (docs/runbooks/transcript-duplicates.md).
 * Without a flag it only lists. Run it in the worker container, which has
 * the database connection and role already:
 *
 *   ./node_modules/.bin/tsx src/repair/transcriptDuplicates.cli.ts [--apply | --restore]
 */
async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const unknown = [...flags].filter((flag) => flag !== '--apply' && flag !== '--restore');
  if (unknown.length > 0 || (flags.has('--apply') && flags.has('--restore'))) {
    throw new Error(
      `Unrecognised arguments: ${[...flags].join(' ')}. Pass nothing to list, --apply to drop, or --restore to undo a drop.`,
    );
  }
  const root = createDb();
  try {
    const active = await root
      .select({ id: principals.id, upn: principals.upn })
      .from(principals)
      .where(eq(principals.status, 'active'));
    for (const principal of active) {
      const db = scopedDb(root, { principalId: principal.id });
      if (flags.has('--restore')) {
        const restored = await restoreTranscriptDuplicates(db);
        console.info(`${principal.upn}: reopened ${String(restored.length)} commitments.`);
        continue;
      }
      const duplicates = await findTranscriptDuplicates(db);
      const open = duplicates.filter((duplicate) => duplicate.status === 'open');
      console.info(
        `${principal.upn}: ${String(duplicates.length)} duplicates, ${String(open.length)} open.`,
      );
      for (const duplicate of duplicates) {
        console.info(
          `  ${duplicate.commitmentId}  ${duplicate.status.padEnd(7)}  meeting ${duplicate.recordId}  ${duplicate.description}`,
        );
      }
      if (!flags.has('--apply')) continue;
      const result = await dropTranscriptDuplicates(db, duplicates);
      console.info(
        `${principal.upn}: dropped ${String(result.dropped.length)}; left ${String(result.left.length)} that were not open.`,
      );
    }
  } finally {
    await root.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
