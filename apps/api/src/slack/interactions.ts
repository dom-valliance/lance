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
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ackAlert, muteAlert } from '../alerts/service.js';
import type { ApiDeps } from '../deps.js';

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

export const InteractionUserSchema = z.object({ user: z.object({ id: z.string().min(1) }) });

const refusal = (displayName: string): InteractionOutcome =>
  ephemeral(
    `You are not authorised to act on ${displayName}'s proposals from this Slack account: it is not linked to an active Lance user.`,
  );

const laterPhase = (what: string): InteractionOutcome =>
  ephemeral(`${what} arrives in a later phase. Nothing has changed.`);

/**
 * `deps` are those of the principal the pressing Slack user resolves to
 * (`slackPrincipalDeps` in ./routes.ts), or null when Lance does not know
 * them, which refuses every button and modal.
 */
export async function handleInteraction(
  deps: ApiDeps | null,
  payload: unknown,
  displayName: string,
): Promise<InteractionOutcome> {
  const identified = InteractionUserSchema.safeParse(payload);
  if (!identified.success) {
    return ephemeral(
      'That interaction did not name the Slack user who sent it, so it was ignored.',
    );
  }
  if (deps === null) {
    return refusal(displayName);
  }

  const blockActions = BlockActionsSchema.safeParse(payload);
  if (blockActions.success) {
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
 * app leave the same ledger trail. The actor is Dom either way: nothing
 * reaches here until the Dom-only check above has passed.
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
