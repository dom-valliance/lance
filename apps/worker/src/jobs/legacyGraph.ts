import { principals, scopedDb, type Db } from '@lance/db';
import { OntologyRepository, type BackfillResult } from '@lance/ontology';
import { isLegacyOwner, newUlid, principalDisplayName, type Config } from '@lance/shared';
import { icalUidOfGraphEvent } from '../watchers/graph/icalUid.js';

/**
 * Brings a graph written before ADR 0017 up to it, once, in the scope of
 * its owner: the principal whose UPN is `config.dom.email`, under whom
 * every pre-Phase-4 mutation was recorded (ADR 0015 backfilled them to
 * Dom's id). It runs at boot before any job handler or principal context
 * exists, so no other principal's context can build over an unlayered
 * graph and claim the owner's items. The backfill records itself, so a
 * boot after the first records nothing. Null when no principal owns the
 * legacy graph, which a deployment that started after Phase 4 never has.
 */
export async function backfillLegacyGraph(
  root: Db,
  config: Pick<Config, 'dom'>,
): Promise<BackfillResult | null> {
  const rows = await root.select({ id: principals.id, upn: principals.upn }).from(principals);
  const owner = rows.find((row) => isLegacyOwner(row.upn, config));
  if (owner === undefined) return null;
  const db = scopedDb(root, { principalId: owner.id });
  const ontology = new OntologyRepository(
    db,
    { principalId: owner.id },
    { principalName: principalDisplayName(owner.upn, config) },
  );
  return ontology.backfillLayers(
    { correlationId: newUlid() },
    {
      icalUidOf: (graphEventId) => icalUidOfGraphEvent(db, graphEventId),
      legacyOwnerId: owner.id,
    },
  );
}
