import { jobs, type Db, type JobRow } from '@lance/db';
import { newUlid, nowIso } from '@lance/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { ActorOptions } from './control.js';
import { LedgerWriter } from './writer.js';

/**
 * One principal's rows in `jobs` (ADR 0025), for the handle's scope. The
 * worker's reconciler creates them from the registry's declarations and
 * reads them back; the api changes them from Slack. Both go through here,
 * so every change is a `state_changed` ledger event with the old and new
 * values, committed in the same transaction as the row.
 */

/** What the reconciler knows about a declared job when it creates the row. */
export interface JobDefaults {
  readonly slug: string;
  readonly locked: boolean;
}

export interface EnsureJobsResult {
  /** Slugs whose row this call created with the declared defaults. */
  created: string[];
  /** Slugs whose `locked` flag this call brought into line with the declaration. */
  relocked: string[];
}

export type SetEnabledResult =
  | { status: 'changed' | 'unchanged'; job: JobRow }
  | { status: 'locked'; job: JobRow }
  | { status: 'unknown'; slug: string };

/** The part of a job a principal controls, as the ledger records it. */
const settingsOf = (row: Pick<JobRow, 'enabled' | 'scheduleOverride'>) => ({
  enabled: row.enabled,
  scheduleOverride: row.scheduleOverride,
});

export class JobControl {
  private readonly writer: LedgerWriter;

  constructor(private readonly db: Db) {
    this.writer = new LedgerWriter(db);
  }

  /** Every job row the scoped principal has, by slug. */
  async list(): Promise<JobRow[]> {
    return this.db.select().from(jobs).orderBy(asc(jobs.slug));
  }

  /**
   * Creates the rows the principal does not have yet, enabled and with no
   * override, and keeps `locked` equal to the declaration. Idempotent: a
   * second call over the same declarations changes and records nothing.
   */
  async ensure(declared: readonly JobDefaults[], options: ActorOptions): Promise<EnsureJobsResult> {
    if (declared.length === 0) return { created: [], relocked: [] };
    return this.db.transaction(async (tx) => {
      const ts = new Date(nowIso());
      const inserted = await tx
        .insert(jobs)
        .values(
          declared.map((job) => ({
            id: newUlid(),
            slug: job.slug,
            origin: 'system' as const,
            locked: job.locked,
            createdAt: ts,
            updatedAt: ts,
          })),
        )
        .onConflictDoNothing({ target: [jobs.principalId, jobs.slug] })
        .returning({ slug: jobs.slug });
      const created = inserted.map((row) => row.slug);

      const existing = await tx
        .select()
        .from(jobs)
        .where(
          inArray(
            jobs.slug,
            declared.map((job) => job.slug),
          ),
        );
      const relocked: string[] = [];
      for (const job of declared) {
        const row = existing.find((candidate) => candidate.slug === job.slug);
        if (row === undefined || row.locked === job.locked) continue;
        await tx.update(jobs).set({ locked: job.locked, updatedAt: ts }).where(eq(jobs.id, row.id));
        relocked.push(job.slug);
      }

      if (created.length > 0 || relocked.length > 0) {
        await this.writer.append(
          {
            ts: ts.toISOString(),
            actor: options.actor,
            kind: 'state_changed',
            sourceSystem: 'lance',
            correlationId: newUlid(),
            payload: {
              change: 'jobs_declared',
              created,
              relocked: relocked.map((slug) => ({
                slug,
                locked: declared.find((job) => job.slug === slug)?.locked ?? null,
              })),
            },
          },
          tx,
        );
      }
      return { created, relocked };
    });
  }

  /**
   * Enables or disables one job. A locked job cannot be disabled, and
   * enabling one that is already enabled changes nothing but is still
   * recorded, so the ledger shows every request.
   */
  async setEnabled(
    slug: string,
    enabled: boolean,
    options: ActorOptions,
  ): Promise<SetEnabledResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(jobs).where(eq(jobs.slug, slug)).for('update').limit(1);
      const current = rows[0];
      if (current === undefined) return { status: 'unknown', slug };
      if (current.locked && !enabled) return { status: 'locked', job: current };

      const ts = new Date(nowIso());
      const changed = current.enabled !== enabled;
      let job = current;
      if (changed) {
        const updated = await tx
          .update(jobs)
          .set({ enabled, updatedAt: ts })
          .where(eq(jobs.id, current.id))
          .returning();
        job = updated[0] ?? { ...current, enabled, updatedAt: ts };
      }
      await this.writer.append(
        {
          ts: ts.toISOString(),
          actor: options.actor,
          kind: 'state_changed',
          sourceSystem: 'lance',
          correlationId: newUlid(),
          payload: {
            change: 'job',
            slug,
            old: settingsOf(current),
            new: settingsOf(job),
          },
        },
        tx,
      );
      return { status: changed ? 'changed' : 'unchanged', job };
    });
  }
}
