import { hashRecord, idempotencyKey, newUlid } from '@lance/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ServerDeps } from '../deps.js';
import { HttpError, UnauthorisedError } from '../errors.js';
import { constantTimeEquals } from '../secure-compare.js';

/**
 * The agent-logs webhook (spec 7.1, agent-logs row): "POST /ingest/agent-log
 * webhook for any other agent with a shared secret. Emits observed with
 * kind: agent_log."
 *
 * Authentication is a shared secret, not Entra: the callers are other
 * agents, not people. The append is idempotent on
 * `webhook:<recordId>:<hash>`, so a retry writes nothing new
 * (non-negotiable 6).
 */

export const INGEST_SECRET_HEADER = 'x-lance-ingest-secret';

export const AgentLogSchema = z.object({
  agent: z.string().min(1),
  recordId: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type AgentLog = z.infer<typeof AgentLogSchema>;

/**
 * The ledger actor pattern in `packages/shared/src/schemas.ts` allows
 * `agent:[a-z-]+@x.y.z` only, so an arbitrary agent name is folded to lower
 * case and everything outside `a-z` becomes a hyphen. Version `0.0.0`
 * marks a log that came in over the webhook rather than from a versioned
 * agent inside Lance.
 */
export const agentLogActor = (agent: string): string => {
  const name = agent
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `agent:${name.length > 0 ? name : 'unknown'}@0.0.0`;
};

export const ingestRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    fastify.post('/ingest/agent-log', async (request, reply) => {
      const supplied = request.headers[INGEST_SECRET_HEADER];
      if (typeof supplied !== 'string' || !constantTimeEquals(supplied, server.ingestSecret)) {
        throw new UnauthorisedError(
          `The ${INGEST_SECRET_HEADER} header is missing or wrong. Send the shared ingest secret for this environment.`,
        );
      }

      const parsed = AgentLogSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'The agent log body is not valid.',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      // The agents covered by this webhook are Lance's own and the inbox
      // agent (spec 16, Q2), which work for the principal in DOM_EMAIL.
      const owner = await server.directory.byUpn(server.config.dom.email);
      if (owner?.status !== 'active') {
        throw new HttpError(
          503,
          `No active principal has the UPN ${server.config.dom.email}, so an agent log has nobody to be recorded for. Check DOM_EMAIL and the principals table.`,
        );
      }
      const deps = server.depsFor(owner);

      const log = parsed.data;
      const hash = hashRecord(log);
      const result = await deps.writer.append({
        ts: log.observedAt,
        actor: agentLogActor(log.agent),
        kind: 'observed',
        sourceSystem: 'webhook',
        sourceRecordId: log.recordId,
        sourceRecordHash: hash,
        idempotencyKey: idempotencyKey('webhook', log.recordId, hash),
        correlationId: newUlid(),
        payload: { kind: 'agent_log', ...log },
      });

      return reply.code(202).send(result);
    });
  };
