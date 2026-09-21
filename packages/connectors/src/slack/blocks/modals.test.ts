import type { AnyBlock, InputBlock, ModalView, PlainTextInput, StaticSelect } from '@slack/types';
import { describe, expect, it } from 'vitest';
import { CALLBACK } from './actions.js';
import { validProposal } from './fixtures.js';
import {
  parseEditSubmission,
  parseRejectSubmission,
  renderEditModal,
  renderRejectModal,
  type SubmittedView,
} from './modals.js';

/**
 * `ModalView['blocks']` is typed `AnyBlock[]`, a union with the generic
 * `Block` interface, so `block.type === 'input'` alone does not narrow away
 * `Block` (its `type` field is just `string`). This guard does.
 */
function isInputBlock(block: AnyBlock): block is InputBlock {
  return block.type === 'input';
}

/**
 * Builds a `view_submission`-shaped view from a rendered edit modal, using
 * the `block_id`/`action_id` the renderer actually assigned, so the test
 * exercises the same round trip Slack would: render, submit, parse.
 */
function submitEdits(view: ModalView, values: Record<string, string>): SubmittedView {
  const stateValues: SubmittedView['state']['values'] = {};
  for (const block of view.blocks) {
    if (!isInputBlock(block) || block.block_id === undefined) {
      continue;
    }
    const key = block.label.text;
    if (!(key in values)) {
      continue;
    }
    const element = block.element as PlainTextInput;
    if (element.action_id === undefined) {
      continue;
    }
    stateValues[block.block_id] = {
      [element.action_id]: { type: 'plain_text_input', value: values[key] ?? null },
    };
  }
  return { private_metadata: view.private_metadata ?? '', state: { values: stateValues } };
}

function submitReject(
  view: ModalView,
  reasonCode: string | null,
  note: string | null,
): SubmittedView {
  const stateValues: SubmittedView['state']['values'] = {};
  for (const block of view.blocks) {
    if (!isInputBlock(block) || block.block_id === undefined) {
      continue;
    }
    const element = block.element;
    if (element.type === 'static_select') {
      if (element.action_id === undefined) continue;
      stateValues[block.block_id] = {
        [element.action_id]: {
          type: 'static_select',
          selected_option: reasonCode === null ? null : { value: reasonCode },
        },
      };
    } else if (element.type === 'plain_text_input') {
      if (element.action_id === undefined) continue;
      stateValues[block.block_id] = {
        [element.action_id]: { type: 'plain_text_input', value: note },
      };
    }
  }
  return { private_metadata: view.private_metadata ?? '', state: { values: stateValues } };
}

describe('renderEditModal', () => {
  const proposal = validProposal({
    payload: {
      subject: 'Short subject',
      body: 'Line one\nLine two',
      longSingleLine: 'x'.repeat(130),
      count: 3,
      approved: true,
    },
  });

  it('lists exactly the string-valued top-level payload fields', () => {
    const view = renderEditModal(proposal) as ModalView;
    const labels = view.blocks.filter(isInputBlock).map((block) => block.label.text);
    expect(labels.sort()).toEqual(['body', 'longSingleLine', 'subject']);
  });

  it('sets the current value as initial_value', () => {
    const view = renderEditModal(proposal) as ModalView;
    const subject = view.blocks.find(
      (block) => isInputBlock(block) && block.label.text === 'subject',
    );
    if (!subject || !isInputBlock(subject)) throw new Error('Expected the subject input block');
    expect((subject.element as PlainTextInput).initial_value).toBe('Short subject');
  });

  it('is multiline when the value contains a newline', () => {
    const view = renderEditModal(proposal) as ModalView;
    const body = view.blocks.find((block) => isInputBlock(block) && block.label.text === 'body');
    if (!body || !isInputBlock(body)) throw new Error('Expected the body input block');
    expect((body.element as PlainTextInput).multiline).toBe(true);
  });

  it('is multiline when the value is longer than 120 characters', () => {
    const view = renderEditModal(proposal) as ModalView;
    const long = view.blocks.find(
      (block) => isInputBlock(block) && block.label.text === 'longSingleLine',
    );
    if (!long || !isInputBlock(long)) throw new Error('Expected the longSingleLine input block');
    expect((long.element as PlainTextInput).multiline).toBe(true);
  });

  it('is single line for a short value with no newline', () => {
    const view = renderEditModal(proposal) as ModalView;
    const subject = view.blocks.find(
      (block) => isInputBlock(block) && block.label.text === 'subject',
    );
    if (!subject || !isInputBlock(subject)) throw new Error('Expected the subject input block');
    expect((subject.element as PlainTextInput).multiline).toBe(false);
  });

  it('sets the callback id and private_metadata', () => {
    const view = renderEditModal(proposal) as ModalView;
    expect(view.callback_id).toBe(CALLBACK.proposalEdit);
    expect(view.private_metadata).toBe(proposal.id);
  });
});

describe('parseEditSubmission', () => {
  it('round-trips edited values back to their field keys', () => {
    const proposal = validProposal({
      payload: { subject: 'Original subject', body: 'Original\nbody' },
    });
    const view = renderEditModal(proposal) as ModalView;
    const edited = { subject: 'Edited subject', body: 'Edited\nbody, two lines' };

    const parsed = parseEditSubmission(submitEdits(view, edited));

    expect(parsed).toEqual({ proposalId: proposal.id, values: edited });
  });
});

describe('renderRejectModal', () => {
  const proposal = validProposal();

  it('sets the callback id and private_metadata', () => {
    const view = renderRejectModal(proposal) as ModalView;
    expect(view.callback_id).toBe(CALLBACK.proposalReject);
    expect(view.private_metadata).toBe(proposal.id);
  });

  it('offers the four reason codes with British English labels', () => {
    const view = renderRejectModal(proposal) as ModalView;
    const reasonBlock = view.blocks.find(
      (block) => isInputBlock(block) && block.label.text === 'Reason',
    );
    if (!reasonBlock || !isInputBlock(reasonBlock))
      throw new Error('Expected the reason input block');
    const select = reasonBlock.element as StaticSelect;
    expect(select.options?.map((option) => option.value)).toEqual([
      'wrong_target',
      'not_now',
      'bad_draft',
      'other',
    ]);
    expect(select.options?.map((option) => option.text.text)).toEqual([
      'Wrong target',
      'Not right now',
      'Draft needs work',
      'Other',
    ]);
  });

  it('makes the note field optional', () => {
    const view = renderRejectModal(proposal) as ModalView;
    const noteBlock = view.blocks.find(
      (block) => isInputBlock(block) && block.label.text === 'Note (optional)',
    );
    if (!noteBlock || !isInputBlock(noteBlock)) throw new Error('Expected the note input block');
    expect(noteBlock.optional).toBe(true);
  });
});

describe('parseRejectSubmission', () => {
  const proposal = validProposal();

  it('reads the reason code and note', () => {
    const view = renderRejectModal(proposal) as ModalView;
    const parsed = parseRejectSubmission(
      submitReject(view, 'wrong_target', 'Sent to the wrong client'),
    );
    expect(parsed).toEqual({
      proposalId: proposal.id,
      reasonCode: 'wrong_target',
      note: 'Sent to the wrong client',
    });
  });

  it('handles a missing note by returning null', () => {
    const view = renderRejectModal(proposal) as ModalView;
    const parsed = parseRejectSubmission(submitReject(view, 'not_now', null));
    expect(parsed.note).toBeNull();
  });

  it('handles a blank note by returning null', () => {
    const view = renderRejectModal(proposal) as ModalView;
    const parsed = parseRejectSubmission(submitReject(view, 'other', ''));
    expect(parsed.note).toBeNull();
  });

  it('throws when the reason code is missing', () => {
    const view = renderRejectModal(proposal) as ModalView;
    expect(() => parseRejectSubmission(submitReject(view, null, null))).toThrow(/reason code/);
  });
});
