import { nowIso } from '@lance/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DOM_ACTOR, type ApiDeps } from '../deps.js';
import { renderStatus } from '../status.js';
import { handleInteraction } from './interactions.js';
import { verifySlackSignature } from './verify.js';

/**
 * Slack's three endpoints (spec 9.2, slack-app-manifest.json). Everything
 * here answers inline and fast: Slack gives a handler three seconds, and
 * these handlers do one database read at most, so nothing needs
 * `response_url`.
 *
 * Signature verification needs the bytes Slack signed, so this plugin
 * registers its own content type parsers with `parseAs: 'string'` and
 * leaves `request.body` as the raw string. Fastify encapsulates content
 * type parsers per plugin scope, so the rest of the api keeps the default
 * JSON parser and no raw-body plugin is needed.
 */

const EPHEMERAL = 'ephemeral' as const;

interface SlackReply {
  response_type: typeof EPHEMERAL;
  text: string;
}

const ephemeral = (text: string): SlackReply => ({ response_type: EPHEMERAL, text });

const SlashCommandSchema = z.object({
  command: z.string().min(1),
  text: z.string().default(''),
  user_id: z.string().min(1),
  channel_id: z.string().min(1),
});

const UrlVerificationSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string().min(1),
});

const EventEnvelopeSchema = z.object({
  type: z.string().min(1),
  event: z.object({ type: z.string().min(1) }).optional(),
});

const InteractionSchema = z.object({
  type: z.string().min(1),
  actions: z.array(z.object({ action_id: z.string().min(1) })).optional(),
  view: z.object({ callback_id: z.string().min(1) }).optional(),
});

const rawBody = (request: FastifyRequest): string =>
  typeof request.body === 'string' ? request.body : '';

const header = (request: FastifyRequest, name: string): string => {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[0] ?? '') : '';
};

const formFields = (body: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(body));

/** `status pause because of a deploy` becomes `["status", "pause because of a deploy"]`. */
const splitCommand = (text: string): { verb: string; rest: string } => {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { verb: trimmed.toLowerCase(), rest: '' };
  return {
    verb: trimmed.slice(0, firstSpace).toLowerCase(),
    rest: trimmed.slice(firstSpace + 1).trim(),
  };
};

const listIds = (ids: string[]): string => ids.join(', ');

const laterPhase = (command: string, nothing: string): string =>
  `The ${command} command arrives in a later phase. ${nothing}`;

const usage = (): string =>
  'Usage: /lance status | pause [reason] | resume | brief | task <text> | chase <commitment id>';

const handleStatus = async (deps: ApiDeps): Promise<SlackReply> => {
  const snapshot = await deps.status.snapshot();
  return ephemeral(renderStatus(snapshot, deps.config.agentDisplayName));
};

const handlePause = async (
  deps: ApiDeps,
  reason: string,
  displayName: string,
): Promise<SlackReply> => {
  const result = await deps.control.pause({
    reason: reason.length > 0 ? reason : 'paused from Slack',
    actor: DOM_ACTOR,
  });

  const opening = result.changed
    ? `${displayName} is paused.`
    : `${displayName} was already paused, so the existing reason stands.`;
  const held =
    result.heldProposalIds.length === 0
      ? 'No queued proposals were held.'
      : `Held ${String(result.heldProposalIds.length)} queued proposals: ${listIds(result.heldProposalIds)}.`;

  return ephemeral(`${opening} ${held}`);
};

const handleResume = async (deps: ApiDeps, displayName: string): Promise<SlackReply> => {
  const result = await deps.control.resume({ actor: DOM_ACTOR });

  const opening = result.changed
    ? `${displayName} has resumed.`
    : `${displayName} was not paused, so nothing changed.`;
  const released =
    result.releasedProposalIds.length === 0
      ? 'No held proposals were released.'
      : `Released ${String(result.releasedProposalIds.length)} held proposals: ${listIds(result.releasedProposalIds)}.`;

  return ephemeral(`${opening} ${released}`);
};

/**
 * Only Dom may work the kill switch from Slack. The allowlist is one Slack
 * user id from `users.slack_user_id`; an unset id refuses everyone, which
 * is the safe default.
 */
const mayControl = (deps: ApiDeps, userId: string): boolean =>
  deps.slack.allowedUserId !== null && deps.slack.allowedUserId === userId;

export const slackRoutes =
  (deps: ApiDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify: FastifyInstance): Promise<void> => {
    const clock = deps.now ?? nowIso;
    const displayName = deps.config.agentDisplayName;

    const keepRaw = (
      _request: FastifyRequest,
      body: string,
      done: (error: Error | null, body?: string) => void,
    ): void => {
      done(null, body);
    };
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, keepRaw);
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      keepRaw,
    );

    fastify.addHook('preHandler', async (request, reply) => {
      const verification = verifySlackSignature({
        signingSecret: deps.slack.signingSecret,
        timestamp: header(request, 'x-slack-request-timestamp'),
        body: rawBody(request),
        signature: header(request, 'x-slack-signature'),
        now: new Date(clock()),
      });

      if (!verification.ok) {
        request.log.warn({ reason: verification.reason }, 'Rejected an unsigned Slack request');
        await reply
          .code(401)
          .send({ error: `Slack signature verification failed: ${verification.reason}.` });
      }
    });

    fastify.post('/slack/commands', async (request): Promise<SlackReply> => {
      const parsed = SlashCommandSchema.safeParse(formFields(rawBody(request)));
      if (!parsed.success) {
        return ephemeral(`That did not arrive as a Slack slash command. ${usage()}`);
      }

      const { verb, rest } = splitCommand(parsed.data.text);

      switch (verb) {
        case 'status':
          return mayControl(deps, parsed.data.user_id)
            ? handleStatus(deps)
            : ephemeral(
                `${displayName} status is available to Dom only; it includes cursor ages and spend.`,
              );
        case 'pause':
          return mayControl(deps, parsed.data.user_id)
            ? handlePause(deps, rest, displayName)
            : ephemeral(
                `You are not authorised to pause ${displayName} from Slack. Ask Dom, or use the kill switch in Settings.`,
              );
        case 'resume':
          return mayControl(deps, parsed.data.user_id)
            ? handleResume(deps, displayName)
            : ephemeral(
                `You are not authorised to resume ${displayName} from Slack. Ask Dom, or use the kill switch in Settings.`,
              );
        case 'brief':
          return ephemeral(laterPhase('brief', 'No brief has been generated.'));
        case 'task':
          return ephemeral(laterPhase('task', 'No task has been created.'));
        case 'chase':
          return ephemeral(laterPhase('chase', 'No chase has been drafted.'));
        default:
          return ephemeral(usage());
      }
    });

    fastify.post('/slack/events', async (request, reply) => {
      const body: unknown = JSON.parse(rawBody(request) || '{}');

      const challenge = UrlVerificationSchema.safeParse(body);
      if (challenge.success) {
        return reply.send({ challenge: challenge.data.challenge });
      }

      const envelope = EventEnvelopeSchema.safeParse(body);
      request.log.info(
        {
          envelopeType: envelope.success ? envelope.data.type : 'unrecognised',
          eventType: envelope.success ? (envelope.data.event?.type ?? null) : null,
        },
        'Acknowledged a Slack event; handlers arrive in Phase 1',
      );
      return reply.send({ ok: true });
    });

    fastify.post('/slack/interactions', async (request, reply) => {
      const payloadField = formFields(rawBody(request))['payload'] ?? '{}';
      const payload: unknown = JSON.parse(payloadField);
      const envelope = InteractionSchema.safeParse(payload);

      request.log.info(
        {
          interactionType: envelope.success ? envelope.data.type : 'unrecognised',
          actionIds: envelope.success ? (envelope.data.actions?.map((a) => a.action_id) ?? []) : [],
          callbackId: envelope.success ? (envelope.data.view?.callback_id ?? null) : null,
        },
        'Handling a Slack interaction',
      );

      const outcome = await handleInteraction(deps, payload);
      // Slack reads an empty 200 as "accepted, nothing to show"; the card
      // itself has already been redrawn through chat.update.
      return outcome.kind === 'empty' ? reply.code(200).send('') : reply.send(outcome.body);
    });
  };
