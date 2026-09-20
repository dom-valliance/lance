import type { LedgerQuery } from '@lance/ledger';
import { LedgerKindSchema, SourceSystemSchema, UlidSchema } from '@lance/shared';
import { z } from 'zod';
import { procedure, router } from './trpc.js';

/**
 * The tRPC surface `apps/web` calls. `AppRouter` is exported as a type
 * through the package's `./router` entry point so the web app gets end to
 * end types without importing any api runtime code.
 */

const TimestampSchema = z.string().datetime({ offset: true });

/** Mirrors `LedgerQuery` from `@lance/ledger`, validated at the boundary. */
export const LedgerQueryInputSchema = z
  .object({
    kind: LedgerKindSchema.optional(),
    actor: z.string().min(1).optional(),
    sourceSystem: SourceSystemSchema.optional(),
    correlationId: UlidSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    limit: z.int().positive().max(2000).optional(),
  })
  .default({});
export type LedgerQueryInput = z.infer<typeof LedgerQueryInputSchema>;

/**
 * Copies only the keys that were supplied. `exactOptionalPropertyTypes`
 * rejects an explicit `undefined`, and a spread would carry one for every
 * omitted filter.
 */
export const toLedgerQuery = (input: LedgerQueryInput): LedgerQuery => {
  const query: LedgerQuery = {};
  if (input.kind !== undefined) query.kind = input.kind;
  if (input.actor !== undefined) query.actor = input.actor;
  if (input.sourceSystem !== undefined) query.sourceSystem = input.sourceSystem;
  if (input.correlationId !== undefined) query.correlationId = input.correlationId;
  if (input.from !== undefined) query.from = input.from;
  if (input.to !== undefined) query.to = input.to;
  if (input.limit !== undefined) query.limit = input.limit;
  return query;
};

export const appRouter = router({
  systemState: router({
    get: procedure.query(({ ctx }) => ctx.deps.control.read()),
  }),
  ledger: router({
    query: procedure
      .input(LedgerQueryInputSchema)
      .query(({ ctx, input }) => ctx.deps.ledger.query(toLedgerQuery(input))),
    byCorrelation: procedure
      .input(z.object({ correlationId: UlidSchema }))
      .query(({ ctx, input }) => ctx.deps.ledger.byCorrelation(input.correlationId)),
  }),
});

export type AppRouter = typeof appRouter;
