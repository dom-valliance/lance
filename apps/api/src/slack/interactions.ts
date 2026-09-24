import {
  ACTION,
  CALLBACK,
  parseActionValue,
  parseEditSubmission,
  parseRejectSubmission,
  renderEditModal,
  renderRejectModal,
  type SubmittedView,
} from '@lance/connectors';
import { ProposalTransitionError } from '@lance/ledger';
import { hashRecord, nowIso } from '@lance/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ackAlert, muteAlert } from '../alerts/service.js';
import type { ApiDeps, PrincipalRef } from '../deps.js';

/**
 * Slack's interactivity payloads (spec 9.1): the four buttons on a proposal
 * card, the two on an alert card, and the two modals two of them open.
 * Everything here is pure mapping and delegation; the decision itself goes
 * through `deps.decide`, which is `applyDecision`, which is the ledger's
 * state machine, and an alert change goes through the same service the
 * Alerts page calls. Nothing in this file writes a status of its own.
 *
 * Slack gives an interaction handler three seconds. Approve and Snooze do
 * one decision and one card update, Edit and Reject open a modal, so none
 * of them needs `response_url`.
 *
 * A button is honoured only for the principal whose channel the card sits
 * in (ADR 0023). A press by anyone else is refused and raises a P1
 * `foreign_decision_attempt` in the card owner's scope. Whatever passes
 * that check still decides through the presser's own scope, where row-level
 * security shows no other principal's proposal at all.
 */

/** The card's button says "Snooze 4h"; the handler must mean the same thing. */
export const SNOOZE_HOURS = 4;

/** The alert card's button says "Mute 24h"; the handler must mean the same thing. */
export const MUTE_HOURS = 24;

const EPHEMERAL = 'ephemeral' as const;

export interface EphemeralReply {
  response_type: typeof EPHEMERAL;
  text: string;
}

/** What the route sends back. Slack treats an empty 200 as "accepted". */
export type InteractionOutcome =
  { kind: 'empty' } | { kind: 'json'; body: EphemeralReply | { response_action: 'clear' } };

const ephemeral = (text: string): InteractionOutcome => ({
  kind: 'json',
  body: { response_type: EPHEMERAL, text },
});

const StateValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plain_text_input'), value: z.string().nullable() }),
  z.object({
    type: z.literal('static_select'),
    selected_option: z.object({ value: z.string() }).nullable(),
  }),
]);

const BlockActionsSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id: z.string().min(1) }),
  trigger_id: z.string().min(1).optional(),
  channel: z.object({ id: z.string().min(1) }).optional(),
  container: z
    .object({ channel_id: z.string().min(1).optional(), message_ts: z.string().optional() })
    .optional(),
  actions: z.array(z.object({ action_id: z.string().min(1), value: z.string().optional() })).min(1),
});

const ViewSubmissionSchema = z.object({
  type: z.literal('view_submission'),
  user: z.object({ id: z.string().min(1) }),
  view: z.object({
    callback_id: z.string().min(1),
    private_metadata: z.string(),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), StateValueSchema)) }),
  }),
});

export const InteractionUserSchema = z.object({
  user: z.object({ id: z.string().min(1), team_id: z.string().min(1).optional() }),
  team: z.object({ id: z.string().min(1) }).nullish(),
});

/** The one reply an unlinked Slack user gets (ADR 0021). */
export const loginPrompt = (displayName: string): string =>
  `This Slack account is not linked to ${displayName}. Run /lance login to link it; nothing else works until you do.`;

/** Who pressed, resolved from the signed Slack user id, and how to find a card's owner. */
export interface InteractionActor {
  slackUserId: string;
  principal: PrincipalRef;
  /** The presser's own dependencies: every decision runs in their scope. */
  deps: ApiDeps;
  /** The principal whose channel this is, with their dependencies, or null when no principal owns it. */
  channelOwner: (
    channelId: string,
  ) => Promise<{ principal: Pick<PrincipalRef, 'id' | 'upn'>; deps: ApiDeps } | null>;
}

const laterPhase = (what: string): InteractionOutcome =>
  ephemeral(`${what} arrives in a later phase. Nothing has changed.`);

/**
 * `actor` is the active principal the pressing Slack user resolves to
 * through their link (`slackActor` in ./routes.ts), or null when they have
 * none, which answers every button and modal with the login prompt alone.
 */
export async function handleInteraction(
  actor: InteractionActor | null,
  payload: unknown,
  displayName: string,
): Promise<InteractionOutcome> {
  const identified = InteractionUserSchema.safeParse(payload);
  if (!identified.success) {
    return ephemeral(
      'That interaction did not name the Slack user who sent it, so it was ignored.',
    );
  }
  if (actor === null) {
    return ephemeral(loginPrompt(displayName));
  }
  const { deps } = actor;

  const blockActions = BlockActionsSchema.safeParse(payload);
  if (blockActions.success) {
    const refused = await refuseForeignPress(actor, blockActions.data, displayName);
    if (refused !== null) return refused;
    return await handleBlockAction(deps, blockActions.data);
  }

  const submission = ViewSubmissionSchema.safeParse(payload);
  if (submission.success) {
    return await handleViewSubmission(deps, submission.data);
  }

  return ephemeral(
    `${displayName} does not handle that kind of Slack interaction. Use the buttons on a proposal card.`,
  );
}

type BlockActions = z.infer<typeof BlockActionsSchema>;
type ViewSubmission = z.infer<typeof ViewSubmissionSchema>;

/**
 * Refuses a press on a card in another principal's channel and tells that
 * principal, in their own scope. Null lets the press through: the card is
 * in the presser's own channel, or in one no principal owns.
 */
async function refuseForeignPress(
  actor: InteractionActor,
  payload: BlockActions,
  displayName: string,
): Promise<InteractionOutcome | null> {
  const channelId = payload.channel?.id ?? payload.container?.channel_id;
  if (channelId === undefined) return null;
  const owner = await actor.channelOwner(channelId);
  if (owner === null || owner.principal.id === actor.principal.id) return null;

  const action = payload.actions[0];
  const actionId = action?.action_id ?? 'unknown';
  const recordId = readRecordId(action?.value) ?? 'an unreadable record';
  const messageTs = payload.container?.message_ts ?? 'unknown';
  const observedAt = (owner.deps.now ?? nowIso)();
  await owner.deps.raiseAlert({
    kind: 'foreign_decision_attempt',
    severity: 'P1',
    dedupeKey: `foreign_decision:${actor.slackUserId}:${recordId}`,
    title: 'Someone else pressed a button on one of your cards',
    body: `Slack user <@${actor.slackUserId}>, who acts for ${actor.principal.upn}, pressed "${actionId}" on ${recordId} in your channel. ${displayName} refused it and nothing changed. Check who else is in the channel.`,
    provenance: [
      {
        system: 'slack',
        recordId: `${channelId}:${messageTs}`,
        hash: hashRecord({
          slackUserId: actor.slackUserId,
          actionId,
          value: action?.value ?? null,
          channelId,
          messageTs,
        }),
        observedAt,
      },
    ],
    actor: 'system:slack-guard',
  });
  return ephemeral(
    `That card belongs to another ${displayName} user, so the button was refused and nothing changed. They have been alerted.`,
  );
}

async function handleBlockAction(
  deps: ApiDeps,
  payload: BlockActions,
): Promise<InteractionOutcome> {
  const action = payload.actions[0];
  if (action === undefined)
    return ephemeral('That interaction carried no action, so it was ignored.');

  const actionId: string = action.action_id;
  switch (actionId) {
    case ACTION.proposalApprove:
      return await decide(deps, action.value, { action: 'approve' });
    case ACTION.proposalSnooze:
      return await decide(deps, action.value, { action: 'snooze', snoozeHours: SNOOZE_HOURS });
    case ACTION.proposalEdit:
      return await openModal(deps, payload, action.value, 'edit');
    case ACTION.proposalReject:
      return await openModal(deps, payload, action.value, 'reject');
    case ACTION.executedUndo:
      return laterPhase('Undo');
    case ACTION.alertAck:
      return await actOnAlert(deps, action.value, 'ack');
    case ACTION.alertMute:
      return await actOnAlert(deps, action.value, 'mute');
    default:
      return ephemeral(
        `That button (${actionId}) is not one ${deps.config.agentDisplayName} answers.`,
      );
  }
}

interface DecisionShape {
  action: 'approve' | 'snooze' | 'edit' | 'reject';
  note?: string;
  reasonCode?: string;
  editedPayload?: Record<string, unknown>;
  snoozeHours?: number;
}

/** Applies one decision, turning a refused transition into a readable reply. */
async function decide(
  deps: ApiDeps,
  value: string | undefined,
  shape: DecisionShape,
): Promise<InteractionOutcome> {
  const proposalId = readRecordId(value);
  if (proposalId === null) {
    return ephemeral('That button carried no proposal id, so nothing was decided.');
  }

  try {
    await deps.decide({ proposalId, actor: deps.actor, ...shape });
  } catch (error) {
    if (error instanceof ProposalTransitionError) return ephemeral(error.message);
    throw error;
  }
  return { kind: 'empty' };
}

/** The ULID a card button carries, or null when it carries none or a malformed one. */
function readRecordId(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return parseActionValue(value).id;
  } catch {
    return null;
  }
}

/**
 * Acks or mutes the alert the card names. Both go through the same service
 * functions the Alerts page calls, so a Slack click and a click in the web
 * app leave the same ledger trail, under the presser's own actor.
 */
async function actOnAlert(
  deps: ApiDeps,
  value: string | undefined,
  which: 'ack' | 'mute',
): Promise<InteractionOutcome> {
  const alertId = readRecordId(value);
  if (alertId === null) {
    return ephemeral('That button carried no alert id, so nothing was changed.');
  }

  try {
    await (which === 'ack'
      ? ackAlert(deps, { id: alertId, actor: deps.actor })
      : muteAlert(deps, { id: alertId, hours: MUTE_HOURS, actor: deps.actor }));
  } catch (error) {
    if (error instanceof TRPCError) return ephemeral(error.message);
    throw error;
  }
  return { kind: 'empty' };
}

async function openModal(
  deps: ApiDeps,
  payload: BlockActions,
  value: string | undefined,
  which: 'edit' | 'reject',
): Promise<InteractionOutcome> {
  const proposalId = readRecordId(value);
  if (proposalId === null) {
    return ephemeral('That button carried no proposal id, so no modal was opened.');
  }
  if (payload.trigger_id === undefined) {
    return ephemeral(
      'Slack sent no trigger id, so the modal could not be opened. Try the button again.',
    );
  }
  if (deps.slackSurface === null) {
    return ephemeral(
      `${deps.config.agentDisplayName} has no Slack bot token configured, so modals are unavailable. Decide in the web app instead.`,
    );
  }

  const proposal = await deps.proposals.get(proposalId);
  if (proposal === null) {
    return ephemeral(`Proposal ${proposalId} no longer exists.`);
  }

  await deps.slackSurface.openView(
    {
      triggerId: payload.trigger_id,
      view: which === 'edit' ? renderEditModal(proposal) : renderRejectModal(proposal),
    },
    { correlationId: proposal.correlationId, proposalId: proposal.id },
  );
  return { kind: 'empty' };
}

const CLEAR: InteractionOutcome = { kind: 'json', body: { response_action: 'clear' } };

async function handleViewSubmission(
  deps: ApiDeps,
  payload: ViewSubmission,
): Promise<InteractionOutcome> {
  const view: SubmittedView = {
    private_metadata: payload.view.private_metadata,
    state: payload.view.state,
  };

  if (payload.view.callback_id === CALLBACK.proposalEdit) {
    const submitted = parseEditSubmission(view);
    const outcome = await decide(deps, submitted.proposalId, {
      action: 'edit',
      editedPayload: submitted.values,
    });
    return outcome.kind === 'empty' ? CLEAR : outcome;
  }

  if (payload.view.callback_id === CALLBACK.proposalReject) {
    const submitted = parseRejectSubmission(view);
    const outcome = await decide(deps, submitted.proposalId, {
      action: 'reject',
      reasonCode: submitted.reasonCode,
      ...(submitted.note === null ? {} : { note: submitted.note }),
    });
    return outcome.kind === 'empty' ? CLEAR : outcome;
  }

  return ephemeral(
    `${deps.config.agentDisplayName} does not handle the modal "${payload.view.callback_id}".`,
  );
}
