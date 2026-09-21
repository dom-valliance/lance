import { isUlid, type Ulid } from '@lance/shared';

/**
 * Namespaced Slack Block Kit action ids for every interactive element the
 * renderers in this directory produce (WP1.9, spec 9.1). A button's `value`
 * always carries the proposal or alert id it acts on.
 */
export const ACTION = {
  proposalApprove: 'proposal:approve',
  proposalEdit: 'proposal:edit',
  proposalReject: 'proposal:reject',
  proposalSnooze: 'proposal:snooze',
  executedUndo: 'executed:undo',
  alertAck: 'alert:ack',
  alertMute: 'alert:mute',
} as const;

export type ActionId = (typeof ACTION)[keyof typeof ACTION];

/** Namespaced `callback_id`s for the modals `modals.ts` produces. */
export const CALLBACK = {
  proposalEdit: 'proposal_edit_modal',
  proposalReject: 'proposal_reject_modal',
} as const;

export type CallbackId = (typeof CALLBACK)[keyof typeof CALLBACK];

export interface ActionValue {
  id: Ulid;
}

/**
 * Parses a Slack interactive element's `value`, which every button
 * rendered in this directory sets to the proposal or alert id it acts on.
 * Throws when the value is not a 26-character Crockford base32 ULID, so a
 * malformed or tampered payload fails loudly instead of silently acting on
 * the wrong record.
 */
export function parseActionValue(value: string): ActionValue {
  if (!isUlid(value)) {
    throw new Error(`Expected a 26-character ULID button value, received "${value}"`);
  }
  return { id: value };
}
