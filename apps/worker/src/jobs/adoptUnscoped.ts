import { principals, scopedDb, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { hashRecord, newUlid, nowIso } from '@lance/shared';
import type { PgBoss } from 'pg-boss';
import { raiseAlert } from '../alerts/raise.js';
import { BOSS_SCHEMA } from '../scheduler/boss.js';
import { QUEUES } from '../scheduler/queues.js';
import { organisationAdmins } from './admins.js';
import { SYSTEM_JOBS } from './registry.js';
import { principalJobOptions } from './scoped.js';

/**
 * Adopts jobs queued without a principal (docs/runbooks/deploy.md,
 * upgrading from Phase 4). A Phase 4 image put jobs on the queues with no
 * `principalId`; the Phase 5 job wrapper fails every one of them for good.
 * At boot, before any handler fetches, each such job still waiting
 * (`created` or `retry`) on a per-principal queue is sent again with its
 * owner's id and group, and the original is completed with the id of its
 * replacement. The owner is the only principal there is, or else the only
 * principal that existed when the job was queued: a job queued before a
 * second principal existed can only have been the first one's.
 *
 * When neither holds, the worker does not guess. Those jobs stay where
 * they are, the log says which, and every organisation admin gets an alert
 * naming them; the job wrapper then fails them as before.
 */

export const ADOPTION_ACTOR = 'system:job-adoption';

/** Every queue whose jobs name the principal they run for. */
export const PRINCIPAL_QUEUES: readonly string[] = [
  ...new Set([
    ...SYSTEM_JOBS.filter((job) => job.scope === 'principal').map((job) => job.slug),
    QUEUES.execute,
    QUEUES.triage,
    QUEUES.bulkMail,
    QUEUES.chase,
  ]),
];

interface UnscopedJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  createdOn: Date;
}

export interface AdoptedJob {
  queue: string;
  from: string;
  /** The replacement's id; null when pg-boss kept an equivalent singleton instead. */
  to: string | null;
  principalId: string;
}

export interface AdoptionResult {
  adopted: AdoptedJob[];
  /** Jobs left unrun because no single principal could own them. */
  held: { queue: string; jobId: string }[];
}

export interface AdoptionOptions {
  boss: Pick<PgBoss, 'send' | 'complete'>;
  root: Db;
  /** `config.dom.email`, for the alert when no admin role is recorded. */
  fallbackAdminUpn: string;
  queues?: readonly string[];
  now?: () => string;
}

async function unscopedJobs(root: Db, queues: readonly string[]): Promise<UnscopedJob[]> {
  const result = await root.$client.query(
    `SELECT id, name, data, created_on
       FROM ${BOSS_SCHEMA}.job
      WHERE name = ANY($1::text[])
        AND state IN ('created', 'retry')
        AND NOT (jsonb_typeof(data) = 'object' AND data ? 'principalId')
      ORDER BY created_on, id`,
    [queues],
  );
  const rows = result.rows as { id: string; name: string; data: unknown; created_on: Date }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    data:
      typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    createdOn: row.created_on,
  }));
}

export async function adoptUnscopedJobs(options: AdoptionOptions): Promise<AdoptionResult> {
  const { boss, root } = options;
  const clock = options.now ?? nowIso;
  const result: AdoptionResult = { adopted: [], held: [] };
  const jobs = await unscopedJobs(root, options.queues ?? PRINCIPAL_QUEUES);
  if (jobs.length === 0) return result;

  const everyone = await root
    .select({ id: principals.id, createdAt: principals.createdAt })
    .from(principals);
  const ownerOf = (job: UnscopedJob): string | null => {
    if (everyone.length === 1) return everyone[0]?.id ?? null;
    const existing = everyone.filter((p) => p.createdAt.getTime() <= job.createdOn.getTime());
    return existing.length === 1 ? (existing[0]?.id ?? null) : null;
  };

  for (const job of jobs) {
    const principalId = ownerOf(job);
    if (principalId === null) {
      result.held.push({ queue: job.name, jobId: job.id });
      continue;
    }
    const to = await boss.send(
      job.name,
      { ...job.data, principalId },
      principalJobOptions(principalId),
    );
    // Null when a singleton already stands for this work; the original is done either way.
    result.adopted.push({ queue: job.name, from: job.id, to, principalId });
    await boss.complete(job.name, job.id, { adoptedAs: to, principalId }, { includeQueued: true });
  }

  const byPrincipal = new Map<string, AdoptedJob[]>();
  for (const adopted of result.adopted) {
    byPrincipal.set(adopted.principalId, [
      ...(byPrincipal.get(adopted.principalId) ?? []),
      adopted,
    ]);
  }
  for (const [principalId, adopted] of byPrincipal) {
    await new LedgerWriter(scopedDb(root, { principalId })).append({
      ts: clock(),
      actor: ADOPTION_ACTOR,
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload: {
        change: 'jobs_adopted',
        jobs: adopted.map(({ queue, from, to }) => ({ queue, from, to })),
      },
    });
  }

  if (result.held.length > 0) {
    console.error(
      { held: result.held, principals: everyone.length },
      'jobs queued without a principal were left unrun: more than one principal could own them',
    );
    const ts = clock();
    for (const admin of await organisationAdmins(root, options.fallbackAdminUpn)) {
      await raiseAlert(scopedDb(root, { principalId: admin.id }), {
        kind: 'unscoped_jobs_held',
        severity: 'P1',
        dedupeKey: `unscoped_jobs_held:${ts.slice(0, 10)}`,
        title: `${String(result.held.length)} queued jobs name no principal and were not run`,
        body: [
          `The worker found ${String(result.held.length)} jobs queued without a principal, on ${[...new Set(result.held.map((held) => held.queue))].join(', ')}, and more than one principal existed when they were queued, so it could not tell whose they were.`,
          'They stay on the queue and fail when a worker fetches them; nothing ran for anyone.',
          'Suggested action: read the job ids in the worker log line "jobs queued without a principal were left unrun" and send again, from the principal\'s own page, anything that still matters.',
        ].join(' '),
        provenance: result.held.map((held) => ({
          system: 'lance' as const,
          recordId: `pgboss.job:${held.jobId}`,
          hash: hashRecord(held),
          observedAt: ts,
        })),
        actor: ADOPTION_ACTOR,
        now: () => ts,
      });
    }
  }
  return result;
}
