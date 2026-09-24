import { principals, type Db, type Principal } from '@lance/db';
import { UlidSchema } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { work } from '../scheduler/boss.js';

/**
 * Per-principal job execution (ADR 0025). Every job payload carries the
 * principal it runs for; this wrapper validates it, checks the principal
 * against `principals`, and hands the handler that principal's context.
 */

/** The part of every per-principal payload the wrapper reads. */
export const PrincipalPayloadSchema = z.object({ principalId: UlidSchema }).passthrough();

/** A job whose payload names no principal, or one that is not in `principals`: a bug upstream, so it fails loudly. */
export class JobScopeError extends Error {
  override readonly name = 'JobScopeError';
}

export type Resolution<TContext> =
  { status: 'active'; context: TContext } | { status: 'inactive'; principal: Principal };

/**
 * One context per principal, built on first use and kept. The principal's
 * status is read fresh for every job, so a principal paused or offboarded
 * between two runs gets no second one. A context is rebuilt when the
 * principal's Slack channel has changed since it was built, which happens
 * once, at their first link (ADR 0023), so their delivery moves with it.
 */
export class PrincipalContexts<TContext> {
  private readonly built = new Map<string, Promise<TContext>>();
  private readonly channels = new Map<string, string | null>();

  constructor(
    private readonly root: Db,
    private readonly build: (principal: Principal) => Promise<TContext>,
  ) {}

  async resolve(principalId: string): Promise<Resolution<TContext>> {
    const rows = await this.root
      .select()
      .from(principals)
      .where(eq(principals.id, principalId))
      .limit(1);
    const principal = rows[0];
    if (principal === undefined) {
      throw new JobScopeError(
        `The job names principal ${principalId}, which is not in the principals table. ` +
          'Whatever enqueued it named the wrong principal; nothing was run.',
      );
    }
    if (principal.status !== 'active') {
      this.evict(principalId);
      return { status: 'inactive', principal };
    }
    if (
      this.channels.has(principalId) &&
      this.channels.get(principalId) !== principal.slackChannelId
    ) {
      this.evict(principalId);
    }
    let context = this.built.get(principalId);
    if (context === undefined) {
      context = this.build(principal);
      this.built.set(principalId, context);
      this.channels.set(principalId, principal.slackChannelId);
      // A failed build is not kept, so the next job tries again.
      context.catch(() => this.built.delete(principalId));
    }
    return { status: 'active', context: await context };
  }

  /** Drops a principal's context, for a principal who is no longer active. */
  evict(principalId: string): void {
    this.built.delete(principalId);
    this.channels.delete(principalId);
  }

  /** Principals with a context, for the boot log and tests. */
  loaded(): string[] {
    return [...this.built.keys()];
  }
}

/**
 * `work()` for a per-principal queue. The payload is parsed with `schema`,
 * which must include `principalId`; a job for a principal who is not
 * active completes as a no-op with a log line, and one for a principal who
 * does not exist fails through `work()`, which logs it and lets pg-boss
 * record the failure.
 */
export function workForPrincipal<TContext, TSchema extends z.ZodType<{ principalId: string }>>(
  boss: PgBoss,
  queue: string,
  schema: TSchema,
  contexts: PrincipalContexts<TContext>,
  handler: (context: TContext, data: z.infer<TSchema>) => Promise<void>,
): Promise<string> {
  return work<unknown>(boss, queue, async (jobs) => {
    for (const job of jobs) {
      const parsed = schema.safeParse(job.data);
      if (!parsed.success) {
        throw new JobScopeError(
          `Job ${job.id} on ${queue} has a payload that does not match its schema: ` +
            parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ') +
            '. Every job must name the principal it runs for.',
        );
      }
      const resolution = await contexts.resolve(parsed.data.principalId);
      if (resolution.status === 'inactive') {
        console.info(
          {
            queue,
            jobId: job.id,
            principalId: resolution.principal.id,
            status: resolution.principal.status,
          },
          'job skipped: the principal is not active',
        );
        continue;
      }
      await handler(resolution.context, parsed.data);
    }
  });
}
