import { desc } from 'drizzle-orm';
import { observations } from './schema/observations.js';

/**
 * The ORDER BY behind every "newest observation per source record" read,
 * paired with DISTINCT ON source_record_id. Newest means most recently
 * recorded, and the ledger event id says that: it is a monotonic ULID
 * minted at append time.
 *
 * `ts` is deliberately not the key. It is the source's own stamp, a Graph
 * event's lastModifiedDateTime or a Notion page's last edit, and a later,
 * fuller read of a record can carry an earlier stamp than a cut-down read
 * that fell back to the poll time. Ordering by `ts` kept the cut-down
 * calendar occurrences ahead of the full ones the resync recorded.
 */
export const newestObservationFirst = () =>
  [observations.sourceRecordId, desc(observations.id)] as const;
