import { nowIso, SystemModeSchema, toLondon, UlidSchema } from '@lance/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resumeAndRequeue, type ApiDeps, type ServerDeps } from '../deps.js';
import { renderStatus } from '../status.js';
import { handleInteraction, InteractionUserSchema } from './interactions.js';
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
  'Usage: /lance status | pause [reason | all | <job>] | resume [all | <job>] | jobs | mode [live|dry_run] | brief | task <text> | chase <commitment id>';

/** A job slug as the registry writes them: lower case words joined by hyphens or underscores. */
const JOB_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

/**
 * `/lance pause all` and `resume all` act on every principal; `pause <job>`
 * and `resume <job>` on one of the caller's jobs; anything else after
 * `pause` is the reason. A single hyphenated word is read as a job, so a
 * mistyped job name is refused rather than pausing everything with it as
 * the reason.
 */
type PauseTarget =
  { kind: 'all' } | { kind: 'job'; slug: string } | { kind: 'self'; reason: string };

const pauseTarget = (rest: string): PauseTarget => {
  const trimmed = rest.trim();
  if (trimmed.toLowerCase() === 'all') return { kind: 'all' };
  if (JOB_SLUG.test(trimmed)) return { kind: 'job', slug: trimmed };
  return { kind: 'self', reason: trimmed };
};

const handleJobs = async (deps: ApiDeps, displayName: string): Promise<SlackReply> => {
  const jobs = await deps.jobs.list();
  if (jobs.length === 0) {
    return ephemeral(
      `${displayName} has no jobs for you yet. The worker creates them on its next reconcile, within a minute of it starting.`,
    );
  }
  const lines = jobs.map((job) => {
    const state = job.enabled ? 'on' : 'paused';
    const locked = job.locked ? ', locked' : '';
    const next =
      job.nextRunAt === null
        ? job.enabled
          ? 'not scheduled yet'
          : 'no next run'
        : `next run ${toLondon(job.nextRunAt)}`;
    return `• \`${job.slug}\`: ${state}${locked}, ${next}`;
  });
  return ephemeral(
    [
      `Your ${displayName} jobs:`,
      ...lines,
      'Pause one with /lance pause <job> and resume it with /lance resume <job>. Locked jobs keep running.',
    ].join('\n'),
  );
};

const handleJobToggle = async (
  deps: ApiDeps,
  slug: string,
  enabled: boolean,
): Promise<SlackReply> => {
  const status = await deps.jobs.setEnabled(slug, enabled, deps.actor);
  switch (status) {
    case 'unknown':
      return ephemeral(
        `You have no job called ${slug}, so nothing changed. /lance jobs lists your jobs.`,
      );
    case 'locked':
      return ephemeral(
        `${slug} is locked and cannot be paused. It keeps running whatever else is paused.`,
      );
    case 'unchanged':
      return ephemeral(enabled ? `${slug} was already running.` : `${slug} was already paused.`);
    case 'changed':
      return ephemeral(
        enabled
          ? `${slug} is running again; its schedule returns within a minute.`
          : `${slug} is paused; it will not run again until you resume it with /lance resume ${slug}.`,
      );
  }
};

/**
 * Whether the resolved principal may pause or resume every principal.
 * Slack requests carry no Entra token, so the `Lance.Admin` role is not
 * known here; until package 5.4 brings the role to Slack, only the
 * principal whose UPN is `config.dom.email` may. tRPC's `admin.pauseAll`
 * checks the role itself.
 */
const mayControlOrganisation = (deps: ApiDeps): boolean =>
  deps.upn.toLowerCase() === deps.config.dom.email.toLowerCase();

/** `/lance pause all` sets the global row (ADR 0015), which pauses every principal. */
const handlePauseAll = async (deps: ApiDeps, displayName: string): Promise<SlackReply> => {
  const result = await deps.control.pauseAll({
    reason: 'paused for everyone from Slack',
    actor: deps.actor,
  });
  const opening = result.changed
    ? `${displayName} is paused for every principal.`
    : `${displayName} was already paused for every principal, so the existing reason stands.`;
  const held =
    result.heldProposalIds.length === 0
      ? 'None of your queued proposals needed holding.'
      : `Held ${String(result.heldProposalIds.length)} of your queued proposals: ${listIds(result.heldProposalIds)}.`;
  return ephemeral(
    `${opening} ${held} Other principals' queued proposals are held when their executor next runs.`,
  );
};

const handleResumeAll = async (deps: ApiDeps, displayName: string): Promise<SlackReply> => {
  const result = await deps.control.resumeAll({ actor: deps.actor });
  const opening = result.changed
    ? `The pause over every principal is lifted.`
    : `${displayName} was not paused for every principal, so nothing changed.`;
  return ephemeral(
    `${opening} Resuming each principal is not automatic: anyone who paused themselves stays paused, and proposals held during the pause stay held until that principal runs /lance resume.`,
  );
};

/**
 * `/lance mode` alone reports the mode; `/lance mode live` or `dry_run`
 * switches it. Proposals held in dry run stay held until a pause and
 * resume, so the reply says so rather than re-queuing behind Dom's back.
 */
const handleMode = async (
  deps: ApiDeps,
  rest: string,
  displayName: string,
): Promise<SlackReply> => {
  const wanted = rest.trim().toLowerCase();
  if (wanted === '') {
    const state = await deps.control.read();
    return ephemeral(`${displayName} is in ${state.mode} mode.`);
  }
  const parsed = SystemModeSchema.safeParse(wanted);
  if (!parsed.success) {
    return ephemeral(
      `"${rest.trim()}" is not a mode. Use /lance mode live or /lance mode dry_run.`,
    );
  }
  const result = await deps.control.setMode(parsed.data, { actor: deps.actor });
  const opening = result.changed
    ? `${displayName} is now in ${parsed.data} mode.`
    : `${displayName} was already in ${parsed.data} mode.`;
  const next =
    parsed.data === 'live'
      ? 'Proposals held in dry run stay held: run /lance pause then /lance resume to queue them for execution.'
      : 'Writes are held from now on; nothing already executed is undone.';
  return ephemeral(`${opening} ${next}`);
};

/**
 * `/lance chase <commitment id>` (spec 9.2). The command enqueues and
 * answers inside Slack's three seconds; the worker loads the commitment,
 * drafts the email and posts it as a proposal, so nothing is sent from
 * here (non-negotiable 2).
 */
const handleChase = async (
  deps: ApiDeps,
  rest: string,
  displayName: string,
): Promise<SlackReply> => {
  const id = rest.trim();
  if (id === '') {
    return ephemeral('Usage: /lance chase <commitment id>. The id is on the Commitments page.');
  }
  const parsed = UlidSchema.safeParse(id);
  if (!parsed.success) {
    return ephemeral(
      `"${id}" is not a commitment id. Copy the 26 character id from the Commitments page.`,
    );
  }
  const commitment = await deps.commitments.get(parsed.data);
  if (commitment === null) {
    return ephemeral(
      `No commitment has id ${parsed.data}. Check the id on the Commitments page and try again.`,
    );
  }
  await deps.enqueueChase(parsed.data);
  return ephemeral(
    `${displayName} is preparing a chase draft for "${commitment.description}". It will arrive here as a proposal for you to approve.`,
  );
};

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
    actor: deps.actor,
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
  const result = await resumeAndRequeue(deps);

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
 * The dependencies of the active principal a Slack user works for, or null
 * for a Slack user Lance does not know, which refuses them everything. The
 * user resolves through `principals.slack_user_id`, or through
 * `SLACK_ALLOWED_USER_ID` to the principal in DOM_EMAIL for a row recorded
 * before its Slack id was. Package 5.4 replaces both with `/lance login`.
 */
export const slackPrincipalDeps = async (
  server: Pick<ServerDeps, 'directory' | 'slack' | 'config' | 'depsFor'>,
  slackUserId: string,
): Promise<ApiDeps | null> => {
  let principal = await server.directory.bySlackUserId(slackUserId);
  if (
    principal === null &&
    server.slack.fallbackUserId !== null &&
    server.slack.fallbackUserId === slackUserId
  ) {
    principal = await server.directory.byUpn(server.config.dom.email);
  }
  if (principal?.status !== 'active') return null;
  return server.depsFor(principal);
};

export const slackRoutes =
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify: FastifyInstance): Promise<void> => {
    const clock = server.now ?? nowIso;
    const displayName = server.config.agentDisplayName;

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
        signingSecret: server.slack.signingSecret,
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
      const deps = await slackPrincipalDeps(server, parsed.data.user_id);

      switch (verb) {
        case 'status':
          return deps !== null
            ? handleStatus(deps)
            : ephemeral(
                `${displayName} status is available to Dom only; it includes cursor ages and spend.`,
              );
        case 'pause': {
          if (deps === null) {
            return ephemeral(
              `You are not authorised to pause ${displayName} from Slack. Ask Dom, or use the kill switch in Settings.`,
            );
          }
          const target = pauseTarget(rest);
          if (target.kind === 'job') return handleJobToggle(deps, target.slug, false);
          if (target.kind === 'self') return handlePause(deps, target.reason, displayName);
          return mayControlOrganisation(deps)
            ? handlePauseAll(deps, displayName)
            : ephemeral(
                `Only an admin may pause ${displayName} for everyone. /lance pause pauses you alone.`,
              );
        }
        case 'resume': {
          if (deps === null) {
            return ephemeral(
              `You are not authorised to resume ${displayName} from Slack. Ask Dom, or use the kill switch in Settings.`,
            );
          }
          const target = pauseTarget(rest);
          if (target.kind === 'job') return handleJobToggle(deps, target.slug, true);
          if (target.kind === 'self') return handleResume(deps, displayName);
          return mayControlOrganisation(deps)
            ? handleResumeAll(deps, displayName)
            : ephemeral(
                `Only an admin may resume ${displayName} for everyone. /lance resume resumes you alone.`,
              );
        }
        case 'jobs':
          return deps !== null
            ? handleJobs(deps, displayName)
            : ephemeral(`Only Dom may list the jobs of ${displayName} from Slack.`);
        case 'mode':
          return deps !== null
            ? handleMode(deps, rest, displayName)
            : ephemeral(`Only Dom may change or read the mode of ${displayName} from Slack.`);
        case 'brief':
          if (deps === null) {
            return ephemeral(`Only Dom may ask ${displayName} for a brief from Slack.`);
          }
          await deps.enqueueBrief();
          return ephemeral(
            `${displayName} is regenerating the morning brief; it will post in the channel shortly.`,
          );
        case 'task':
          return ephemeral(laterPhase('task', 'No task has been created.'));
        case 'chase':
          return deps !== null
            ? handleChase(deps, rest, displayName)
            : ephemeral(`Only Dom may ask ${displayName} to chase a commitment from Slack.`);
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

      const user = InteractionUserSchema.safeParse(payload);
      const deps = user.success ? await slackPrincipalDeps(server, user.data.user.id) : null;
      const outcome = await handleInteraction(deps, payload, displayName);
      // Slack reads an empty 200 as "accepted, nothing to show"; the card
      // itself has already been redrawn through chat.update.
      return outcome.kind === 'empty' ? reply.code(200).send('') : reply.send(outcome.body);
    });
  };
