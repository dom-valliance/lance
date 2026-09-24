import { ModeChangeRefusedError } from '@lance/ledger';
import { isLanceAdmin, nowIso, SystemModeSchema, toLondon, UlidSchema } from '@lance/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFromUpn } from '../actor.js';
import { resumeAndRequeue, type ApiDeps, type PrincipalRef, type ServerDeps } from '../deps.js';
import { renderStatus } from '../status.js';
import {
  handleInteraction,
  InteractionUserSchema,
  loginPrompt,
  type InteractionActor,
} from './interactions.js';
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
 *
 * Every signed request is also checked against the replay store (ADR
 * 0021), and every command and interaction resolves its principal from the
 * signed Slack user id through `slack_links`. A user with no link gets the
 * login prompt and nothing else; `/lance login` is the one command they
 * can run.
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
  team_id: z.string().min(1).optional(),
  channel_id: z.string().min(1),
});

type SlashCommand = z.infer<typeof SlashCommandSchema>;

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
  'Usage: /lance login | status | pause [reason | all | <job>] | resume [all | <job>] | jobs | mode [live|dry_run] | brief | task <text> | chase <commitment id>';

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
 * Whether the resolved principal may pause or resume every principal. A
 * Slack request carries no Entra token, so the check reads the Lance roles
 * recorded from the principal's last verified token, at their Slack link
 * or their last sign-in. tRPC's `admin.pauseAll` checks the token itself.
 */
const mayControlOrganisation = (principal: PrincipalRef): boolean =>
  isLanceAdmin(principal.lanceRoles);

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
  let result: { changed: boolean };
  try {
    result = await deps.control.setMode(parsed.data, { actor: deps.actor });
  } catch (error) {
    // A new principal's five working days of dry run; the message names the date.
    if (error instanceof ModeChangeRefusedError) return ephemeral(error.message);
    throw error;
  }
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
 * The principal a Slack user acts for (ADR 0021): the one their active
 * link names, or, while Dom has not linked, the principal in DOM_EMAIL for
 * the Slack id in `SLACK_ALLOWED_USER_ID`. Once that principal has a link
 * the fallback is ignored, whoever sends it.
 */
export const resolveSlackUser = async (
  server: Pick<ServerDeps, 'directory' | 'slack' | 'config'>,
  slackUserId: string,
  slackTeamId: string | null,
): Promise<PrincipalRef | null> => {
  const linked = await server.directory.bySlackUserId(slackUserId, slackTeamId);
  if (linked !== null) return linked;
  if (server.slack.fallbackUserId === null || server.slack.fallbackUserId !== slackUserId) {
    return null;
  }
  const dom = await server.directory.byUpn(server.config.dom.email);
  return dom !== null && dom.slackUserId === null ? dom : null;
};

/** A resolved Slack user and their dependencies, for an active principal only. */
export interface SlackActor {
  principal: PrincipalRef;
  deps: ApiDeps;
}

export const slackActor = async (
  server: Pick<ServerDeps, 'directory' | 'slack' | 'config' | 'depsFor'>,
  slackUserId: string,
  slackTeamId: string | null,
): Promise<SlackActor | null> => {
  const principal = await resolveSlackUser(server, slackUserId, slackTeamId);
  if (principal?.status !== 'active') return null;
  return { principal, deps: server.depsFor(principal) };
};

/**
 * The principal whose channel a card is in (ADR 0023). Before Dom links,
 * `dom-claude-agent` is recorded on no principal and still carries his
 * cards, so it maps to the principal in DOM_EMAIL.
 */
export const slackChannelOwner =
  (server: Pick<ServerDeps, 'directory' | 'config' | 'depsFor'>) =>
  async (channelId: string): Promise<{ principal: PrincipalRef; deps: ApiDeps } | null> => {
    const owner =
      (await server.directory.bySlackChannelId(channelId)) ??
      (channelId === server.config.slack.channelId
        ? await server.directory.byUpn(server.config.dom.email)
        : null);
    return owner === null ? null : { principal: owner, deps: server.depsFor(owner) };
  };

/**
 * `/lance login` (ADR 0021): an ephemeral, single-use link to the web app,
 * where the person signs in with Entra and confirms the binding. The
 * request is recorded in the ledger of the principal the Slack user already
 * acts for, or of the organisation's admin for someone not linked yet.
 */
const handleLogin = async (
  server: ServerDeps,
  command: SlashCommand,
  resolved: PrincipalRef | null,
): Promise<SlackReply> => {
  const displayName = server.config.agentDisplayName;
  if (command.team_id === undefined) {
    return ephemeral(
      'Slack did not say which workspace this came from, so no link was issued. Run /lance login again.',
    );
  }
  const recordFor = resolved ?? (await server.directory.byUpn(server.config.dom.email));
  if (recordFor === null) {
    return ephemeral(
      `${displayName} has no principal for ${server.config.dom.email} to record the request under, so no link was issued. Ask a Lance admin to check DOM_EMAIL.`,
    );
  }
  const issued = await server.slack.links.issue({
    slackUserId: command.user_id,
    slackTeamId: command.team_id,
    recordFor,
    actor: resolved === null ? 'system:slack-login' : actorFromUpn(resolved.upn),
  });
  if (issued.status === 'unconfigured') {
    return ephemeral(
      `${displayName} cannot issue a link: PUBLIC_WEB_URL is not set on the api. Ask a Lance admin.`,
    );
  }
  const opening =
    resolved === null
      ? `Link this Slack account to ${displayName}:`
      : `This Slack account is linked to ${displayName} as ${resolved.upn}. To link it again, or to retry your channel:`;
  return ephemeral(
    `${opening} <${issued.url}|open the link page> and sign in with your Valliance Microsoft account. The link works once, for you alone, and expires at ${toLondon(issued.expiresAt)}.`,
  );
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
      const timestamp = header(request, 'x-slack-request-timestamp');
      const signature = header(request, 'x-slack-signature');
      const verification = verifySlackSignature({
        signingSecret: server.slack.signingSecret,
        timestamp,
        body: rawBody(request),
        signature,
        now: new Date(clock()),
      });

      if (!verification.ok) {
        request.log.warn({ reason: verification.reason }, 'Rejected an unsigned Slack request');
        await reply
          .code(401)
          .send({ error: `Slack signature verification failed: ${verification.reason}.` });
        return;
      }

      if (!(await server.slack.replay.claim(signature, Number(timestamp)))) {
        request.log.warn('Rejected a replayed Slack request');
        await reply.code(401).send({
          error:
            'This Slack request was already received once inside the replay window, so the repeat was refused.',
        });
      }
    });

    fastify.post('/slack/commands', async (request): Promise<SlackReply> => {
      const parsed = SlashCommandSchema.safeParse(formFields(rawBody(request)));
      if (!parsed.success) {
        return ephemeral(`That did not arrive as a Slack slash command. ${usage()}`);
      }

      const { verb, rest } = splitCommand(parsed.data.text);
      const resolved = await resolveSlackUser(
        server,
        parsed.data.user_id,
        parsed.data.team_id ?? null,
      );
      if (verb === 'login') return handleLogin(server, parsed.data, resolved);
      if (resolved === null) return ephemeral(loginPrompt(displayName));
      if (resolved.status !== 'active') {
        return ephemeral(
          `Your ${displayName} account is ${resolved.status}, so nothing but /lance login works from Slack yet.`,
        );
      }
      const principal = resolved;
      const deps = server.depsFor(principal);

      switch (verb) {
        case 'status':
          return handleStatus(deps);
        case 'pause': {
          const target = pauseTarget(rest);
          if (target.kind === 'job') return handleJobToggle(deps, target.slug, false);
          if (target.kind === 'self') return handlePause(deps, target.reason, displayName);
          return mayControlOrganisation(principal)
            ? handlePauseAll(deps, displayName)
            : ephemeral(
                `Only a Lance admin may pause ${displayName} for everyone. /lance pause pauses you alone.`,
              );
        }
        case 'resume': {
          const target = pauseTarget(rest);
          if (target.kind === 'job') return handleJobToggle(deps, target.slug, true);
          if (target.kind === 'self') return handleResume(deps, displayName);
          return mayControlOrganisation(principal)
            ? handleResumeAll(deps, displayName)
            : ephemeral(
                `Only a Lance admin may resume ${displayName} for everyone. /lance resume resumes you alone.`,
              );
        }
        case 'jobs':
          return handleJobs(deps, displayName);
        case 'mode':
          return handleMode(deps, rest, displayName);
        case 'brief':
          await deps.enqueueBrief();
          return ephemeral(
            `${displayName} is regenerating the morning brief; it will post in your channel shortly.`,
          );
        case 'task':
          return ephemeral(laterPhase('task', 'No task has been created.'));
        case 'chase':
          return handleChase(deps, rest, displayName);
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
      let actor: InteractionActor | null = null;
      if (user.success) {
        const slackUserId = user.data.user.id;
        const teamId = user.data.team?.id ?? user.data.user.team_id ?? null;
        const resolved = await slackActor(server, slackUserId, teamId);
        actor =
          resolved === null
            ? null
            : { ...resolved, slackUserId, channelOwner: slackChannelOwner(server) };
      }
      const outcome = await handleInteraction(actor, payload, displayName);
      // Slack reads an empty 200 as "accepted, nothing to show"; the card
      // itself has already been redrawn through chat.update.
      return outcome.kind === 'empty' ? reply.code(200).send('') : reply.send(outcome.body);
    });
  };
