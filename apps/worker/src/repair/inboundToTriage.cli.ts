import { createDb, principals, scopedDb } from '@lance/db';
import { eq } from 'drizzle-orm';
import {
  findOpenInbound,
  moveInboundToTriage,
  restoreInboundFromTriage,
} from './inboundToTriage.js';

/**
 * Lists, moves or restores the open inbound commitments recorded before
 * ADR 0037, for every active principal (docs/runbooks/inbound-to-triage.md).
 * Without a flag it only lists. Run it in the worker container, which has
 * the database connection and role already:
 *
 *   ./node_modules/.bin/tsx src/repair/inboundToTriage.cli.ts [--apply | --restore]
 */
async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const unknown = [...flags].filter((flag) => flag !== '--apply' && flag !== '--restore');
  if (unknown.length > 0 || (flags.has('--apply') && flags.has('--restore'))) {
    throw new Error(
      `Unrecognised arguments: ${[...flags].join(' ')}. Pass nothing to list, --apply to move to triage, or --restore to undo a move.`,
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
        const restored = await restoreInboundFromTriage(db);
        console.info(`${principal.upn}: reopened ${String(restored.length)} commitments.`);
        continue;
      }
      const rows = await findOpenInbound(db);
      console.info(`${principal.upn}: ${String(rows.length)} open inbound commitments.`);
      for (const row of rows) {
        console.info(
          `  ${row.commitmentId}  ${row.createdAt.toISOString().slice(0, 10)}  ${row.description}`,
        );
      }
      if (!flags.has('--apply')) continue;
      const result = await moveInboundToTriage(db, rows);
      console.info(
        `${principal.upn}: moved ${String(result.moved.length)} to triage; left ${String(result.left.length)} that were no longer open.`,
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
