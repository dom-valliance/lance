import type { Db } from '@lance/db';
import { newUlid, nowIso } from '@lance/shared';
import { sql, type SQL } from 'drizzle-orm';
import { LedgerWriter } from './writer.js';

/**
 * Retention for one principal (spec 4.4, ADR 0011, docs/compliance/retention.md).
 *
 * Every write here runs inside one transaction on a handle scoped to the
 * principal, as `lance_retention` (`SET LOCAL ROLE`), so row-level security
 * holds it to that principal's rows and the ledger trigger admits the one
 * change it allows: a payload set to NULL, every other column untouched.
 * Ledger rows are never deleted; `payload_hash` survives, so provenance
 * links still verify. The `retention_applied` event with the counts is
 * appended in the same transaction, back under the session's own role, so
 * a run either nulls and records or does neither.
 *
 * What each window covers:
 *   mail bodies     `observed` events of the mail watcher, whose payload is
 *                   the message with its body, and their observations rows
 *   transcripts     `observed` events from Jamie: meetings with transcripts,
 *                   summaries and action items
 *   derived content `resolved` triage events built from those observations,
 *                   which copy evidence quotes and summaries: nulled at the
 *                   window of the source they came from (the Phase 2 review's
 *                   open decision; ADR 0011 amendment)
 *   model logs      agent `failed` events that carry the model's rejected
 *                   output, and `agent_runs.error`
 *   ledger          every other payload at the ledger window, except the
 *                   ontology's recorded mutations, which the graph is rebuilt
 *                   from and which the spec keeps indefinitely
 *
 * Ages run from `created_at`, when Lance recorded the row, not from the
 * source's own timestamp.
 */

export const RETENTION_ACTOR = 'system:retention';

/** Days each class is kept. Zero means everything recorded before now. */
export interface RetentionWindows {
  mailBodiesDays: number;
  transcriptsDays: number;
  modelLogsDays: number;
  ledgerDays: number;
}

export type RetentionTrigger = 'nightly' | 'offboarding';

export interface RetentionOptions {
  windows: RetentionWindows;
  trigger: RetentionTrigger;
  /** The mail watcher's name, as its observations record it in `payload.watcher`. */
  mailWatcher: string;
  actor?: string;
  /** Injected in tests. Returns an ISO-8601 instant. */
  now?: () => string;
}

export interface RetentionCounts {
  mailBodies: number;
  transcripts: number;
  derivedFromMail: number;
  derivedFromTranscripts: number;
  modelLogs: number;
  agentRunErrors: number;
  ledgerPayloads: number;
  observations: number;
}

export interface RetentionResult {
  counts: RetentionCounts;
  cutoffs: Record<keyof RetentionWindows, string>;
  eventId: string;
}

/** The ontology's recorded mutations (`packages/ontology`, MUTATION_KIND). */
const ONTOLOGY_MUTATION_KIND = 'ontology_mutation';
const TRIAGE_KIND = 'triage';
const SCHEMA_VALIDATION = 'schema_validation';

/** The role could not be assumed: the session's identity is not a member of lance_retention. */
export class RetentionRoleError extends Error {
  override readonly name = 'RetentionRoleError';
}

const INSUFFICIENT_PRIVILEGE = '42501';

const codeOf = (error: unknown): unknown => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code !== undefined) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

const cutoffOf = (now: Date, days: number): Date => {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`A retention window must be a whole number of days, zero or more; got ${String(days)}.`);
  }
  return new Date(now.getTime() - days * 24 * 3600 * 1000);
};

/** Triage events whose observations include one from `system`. */
const derivedFrom = (system: string): SQL => sql`
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(coalesce(ledger_events.payload -> 'observationEventIds', '[]'::jsonb)) AS source(id)
      JOIN ledger_events AS origin ON origin.id = source.id
     WHERE origin.source_system = ${system}
  )`;

export async function applyRetention(
  db: Db,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const clock = options.now ?? nowIso;
  const ts = clock();
  const now = new Date(ts);
  const { windows } = options;
  const cutoff = {
    mailBodiesDays: cutoffOf(now, windows.mailBodiesDays),
    transcriptsDays: cutoffOf(now, windows.transcriptsDays),
    modelLogsDays: cutoffOf(now, windows.modelLogsDays),
    ledgerDays: cutoffOf(now, windows.ledgerDays),
  };
  const newestCutoff = new Date(
    Math.max(...Object.values(cutoff).map((date) => date.getTime())),
  ).toISOString();
  const at = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;

  return db.transaction(async (tx) => {
    const own = await tx.execute<{ role: string }>(sql`SELECT current_user::text AS role`);
    const sessionRole = own.rows[0]?.role;
    if (sessionRole === undefined) {
      throw new Error('Retention could not read the session role, so nothing was changed.');
    }
    try {
      await tx.execute(sql`SET LOCAL ROLE lance_retention`);
    } catch (error) {
      if (codeOf(error) === INSUFFICIENT_PRIVILEGE) {
        throw new RetentionRoleError(
          `The database identity behind this session (${sessionRole}) may not act as lance_retention, so no payload was nulled. Run the migration job with LANCE_RETENTION_MEMBER set to the worker identity (docs/runbooks/deploy.md step 9).`,
        );
      }
      throw error;
    }

    const count = async (statement: SQL): Promise<number> =>
      (await tx.execute(statement)).rowCount ?? 0;

    const mailBodies = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE kind = 'observed' AND source_system = 'graph'
         AND payload ->> 'watcher' = ${options.mailWatcher}
         AND payload IS NOT NULL AND created_at < ${at(cutoff.mailBodiesDays)}`);
    const transcripts = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE kind = 'observed' AND source_system = 'jamie'
         AND payload IS NOT NULL AND created_at < ${at(cutoff.transcriptsDays)}`);
    const derivedFromTranscripts = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE kind = 'resolved' AND payload ->> 'kind' = ${TRIAGE_KIND}
         AND created_at < ${at(cutoff.transcriptsDays)} AND ${derivedFrom('jamie')}`);
    const derivedFromMail = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE kind = 'resolved' AND payload ->> 'kind' = ${TRIAGE_KIND}
         AND created_at < ${at(cutoff.mailBodiesDays)} AND ${derivedFrom('graph')}`);
    const modelLogs = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE kind = 'failed' AND actor LIKE 'agent:%'
         AND payload ->> 'reason' = ${SCHEMA_VALIDATION}
         AND created_at < ${at(cutoff.modelLogsDays)}`);
    const agentRunErrors = await count(sql`
      UPDATE agent_runs SET error = NULL
       WHERE error IS NOT NULL AND started_at < ${at(cutoff.modelLogsDays)}`);
    const ledgerPayloads = await count(sql`
      UPDATE ledger_events SET payload = NULL
       WHERE payload IS NOT NULL AND created_at < ${at(cutoff.ledgerDays)}
         AND NOT (kind = 'resolved' AND payload ->> 'kind' = ${ONTOLOGY_MUTATION_KIND})`);
    // Every observations row repeats its ledger event's payload; it follows
    // the ledger row whichever window nulled it.
    const observationsNulled = await count(sql`
      UPDATE observations SET payload = NULL
       WHERE payload IS NOT NULL AND created_at < ${sql`${newestCutoff}::timestamptz`}
         AND EXISTS (SELECT 1 FROM ledger_events
                      WHERE ledger_events.id = observations.id AND ledger_events.payload IS NULL)`);

    await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(sessionRole)}`);

    const counts: RetentionCounts = {
      mailBodies,
      transcripts,
      derivedFromMail,
      derivedFromTranscripts,
      modelLogs,
      agentRunErrors,
      ledgerPayloads,
      observations: observationsNulled,
    };
    const cutoffs = {
      mailBodiesDays: cutoff.mailBodiesDays.toISOString(),
      transcriptsDays: cutoff.transcriptsDays.toISOString(),
      modelLogsDays: cutoff.modelLogsDays.toISOString(),
      ledgerDays: cutoff.ledgerDays.toISOString(),
    };
    const event = await new LedgerWriter(db).append(
      {
        ts,
        actor: options.actor ?? RETENTION_ACTOR,
        kind: 'retention_applied',
        sourceSystem: 'lance',
        correlationId: newUlid(),
        payload: { trigger: options.trigger, windows, cutoffs, counts },
      },
      tx,
    );
    return { counts, cutoffs, eventId: event.id };
  });
}
