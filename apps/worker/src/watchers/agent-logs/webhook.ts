import type { PollResult } from '../types.js';

/**
 * The `webhook` partition of the `agent-logs` watcher (spec 7.1, third
 * stream).
 *
 * `POST /ingest/agent-log` in `apps/api/src/routes/ingest.ts` already
 * appends an `observed` event with `kind: agent_log` and source system
 * `webhook` for every log another agent sends, under its own shared secret
 * and its own idempotency key. Those rows are observations the moment they
 * land, so this partition has nothing to fetch and nothing to re-emit: a
 * second observation of the same log would be the same content under a new
 * record id, which is exactly what non-negotiable 6 forbids.
 *
 * The partition exists so that the watcher shows the three streams the spec
 * names, and so that the detection those rows feed has a home: the
 * detectors in `detect.ts` read the `observations` table directly on their
 * own fifteen minute schedule. Every poll is empty and the cursor never
 * moves.
 */

export const WEBHOOK_PARTITION = 'webhook';

export function pollWebhook(cursor: string | null): Promise<PollResult> {
  return Promise.resolve({ records: [], nextCursor: cursor });
}
