import type { KnownBlock, View } from '@slack/types';
import type { Proposal } from '@lance/shared';
import { CALLBACK } from './actions.js';

/**
 * `@slack/types` models the views an app sends to `views.open` /
 * `views.push`, not the view Slack sends back on `view_submission` (which
 * adds `state.values` and other server-assigned fields). That payload
 * shape is not published as types anywhere, so it is defined locally here,
 * kept to the handful of fields the two parsers below actually read.
 */
interface PlainTextInputStateValue {
  type: 'plain_text_input';
  value: string | null;
}

interface StaticSelectStateValue {
  type: 'static_select';
  selected_option: { value: string } | null;
}

type StateValue = PlainTextInputStateValue | StaticSelectStateValue;

export interface SubmittedView {
  private_metadata: string;
  state: {
    values: Record<string, Record<string, StateValue>>;
  };
}

const EDIT_FIELD_BLOCK_PREFIX = 'field:';
const EDIT_FIELD_ACTION_ID = 'value';
const MULTILINE_THRESHOLD = 120;

function editableFields(payload: Record<string, unknown>): [string, string][] {
  return Object.entries(payload).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

function editFieldBlock(key: string, value: string): KnownBlock {
  const multiline = value.includes('\n') || value.length > MULTILINE_THRESHOLD;
  return {
    type: 'input',
    block_id: `${EDIT_FIELD_BLOCK_PREFIX}${key}`,
    label: { type: 'plain_text', text: key },
    element: {
      type: 'plain_text_input',
      action_id: EDIT_FIELD_ACTION_ID,
      initial_value: value,
      multiline,
    },
  };
}

/**
 * Renders the edit modal (spec 9.1: "Edit opens a modal pre-filled with
 * the payload's editable fields"). One input block per string-valued
 * top-level key of `proposal.payload`; the field name is both the input's
 * label and, prefixed, its `block_id`, so `parseEditSubmission` can recover
 * it without a separate lookup table.
 */
export function renderEditModal(proposal: Proposal): View {
  return {
    type: 'modal',
    callback_id: CALLBACK.proposalEdit,
    private_metadata: proposal.id,
    title: { type: 'plain_text', text: 'Edit proposal' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: editableFields(proposal.payload).map(([key, value]) => editFieldBlock(key, value)),
  };
}

export interface EditSubmission {
  proposalId: string;
  values: Record<string, string>;
}

/** Parses a submitted edit modal back into the field values Dom changed. */
export function parseEditSubmission(view: SubmittedView): EditSubmission {
  const values: Record<string, string> = {};

  for (const [blockId, actions] of Object.entries(view.state.values)) {
    if (!blockId.startsWith(EDIT_FIELD_BLOCK_PREFIX)) {
      continue;
    }
    const key = blockId.slice(EDIT_FIELD_BLOCK_PREFIX.length);
    const action = actions[EDIT_FIELD_ACTION_ID];
    if (action?.type !== 'plain_text_input') {
      continue;
    }
    values[key] = action.value ?? '';
  }

  return { proposalId: view.private_metadata, values };
}

const REJECT_REASON_CODES = ['wrong_target', 'not_now', 'bad_draft', 'other'] as const;
export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number];

function isRejectReasonCode(value: string): value is RejectReasonCode {
  return (REJECT_REASON_CODES as readonly string[]).includes(value);
}

/** Labels in British English for each `RejectReasonCode` (spec 9.1). */
const REJECT_REASON_LABELS: Record<RejectReasonCode, string> = {
  wrong_target: 'Wrong target',
  not_now: 'Not right now',
  bad_draft: 'Draft needs work',
  other: 'Other',
};

const REJECT_REASON_CODE_BLOCK_ID = 'reason_code';
const REJECT_REASON_CODE_ACTION_ID = 'reason_code';
const REJECT_NOTE_BLOCK_ID = 'reason_note';
const REJECT_NOTE_ACTION_ID = 'reason_note';

/**
 * Renders the reject modal (spec 9.1: "Reject opens an optional reason
 * field"). The reason code is required, since it is training data for the
 * promotion analyser; the free-text note is optional.
 */
export function renderRejectModal(proposal: Proposal): View {
  return {
    type: 'modal',
    callback_id: CALLBACK.proposalReject,
    private_metadata: proposal.id,
    title: { type: 'plain_text', text: 'Reject proposal' },
    submit: { type: 'plain_text', text: 'Reject' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: REJECT_REASON_CODE_BLOCK_ID,
        label: { type: 'plain_text', text: 'Reason' },
        element: {
          type: 'static_select',
          action_id: REJECT_REASON_CODE_ACTION_ID,
          placeholder: { type: 'plain_text', text: 'Select a reason' },
          options: REJECT_REASON_CODES.map((code) => ({
            value: code,
            text: { type: 'plain_text', text: REJECT_REASON_LABELS[code] },
          })),
        },
      },
      {
        type: 'input',
        block_id: REJECT_NOTE_BLOCK_ID,
        optional: true,
        label: { type: 'plain_text', text: 'Note (optional)' },
        element: {
          type: 'plain_text_input',
          action_id: REJECT_NOTE_ACTION_ID,
          multiline: true,
        },
      },
    ],
  };
}

export interface RejectSubmission {
  proposalId: string;
  reasonCode: RejectReasonCode;
  note: string | null;
}

/** Parses a submitted reject modal, tolerating a missing or blank note. */
export function parseRejectSubmission(view: SubmittedView): RejectSubmission {
  const codeAction = view.state.values[REJECT_REASON_CODE_BLOCK_ID]?.[REJECT_REASON_CODE_ACTION_ID];
  if (codeAction?.type !== 'static_select' || codeAction.selected_option === null) {
    throw new Error('Reject submission is missing its reason code');
  }

  const { value: reasonCodeValue } = codeAction.selected_option;
  if (!isRejectReasonCode(reasonCodeValue)) {
    throw new Error(`Unrecognised reject reason code "${reasonCodeValue}"`);
  }

  const noteAction = view.state.values[REJECT_NOTE_BLOCK_ID]?.[REJECT_NOTE_ACTION_ID];
  const noteValue = noteAction?.type === 'plain_text_input' ? (noteAction.value ?? '') : '';

  return {
    proposalId: view.private_metadata,
    reasonCode: reasonCodeValue,
    note: noteValue.length > 0 ? noteValue : null,
  };
}
